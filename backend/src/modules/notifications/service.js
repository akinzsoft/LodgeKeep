'use strict';

/**
 * Notifications service — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.21,
 * ARCHITECTURE.md §13 (outbox).
 *
 * `dispatchPendingOutboxEventsForTenant` is the real dispatch logic —
 * render template, call the email adapter, write the delivery log, update
 * the outbox row's status/attempt_count, retry on transient failure, mark
 * `failed` (a hard bounce or exhausted retries) rather than leaving a row
 * silently `pending` forever. It takes a plain tenant-scoped `context`
 * (built by `src/jobs/outbox-dispatcher.js`'s `workerContext`) and is fully
 * testable against real MySQL with no live queue involved — the same
 * "business logic is a plain function; the transport around it is thin"
 * shape `src/modules/reservations/service.js` already established.
 */

const { scopedDb } = require('../../db');
const { workerContext } = require('../tenancy');
const { resolveEmailAdapter } = require('./email-adapter');
const { escapeHtml, heading, paragraph, note, details, button, codeBlock, loadEmailBranding, renderEmailShell, preheaderFrom } = require('./email-layout');

const staffNotifications = require('./staff-notifications');

const { NOTIFICATION_EVENTS } = staffNotifications;

const MAX_ATTEMPTS = 5;
const BELL_LIMIT = 50;

/** ARCHITECTURE.md §13's event vocabulary, mapped to this pass's actual template keys — see this module's own `index.js` header for exactly which events are wired. */
const EVENT_TEMPLATE_KEYS = {
  'reservation.confirmed': 'reservation_confirmed',
  'reservation.cancelled': 'reservation_cancelled',
  'guest.checked_in': 'checked_in',
  'guest.checked_out': 'checked_out',
  // PLAN.md Phase 1 gap closure (src/modules/users) — the recipient here is
  // a staff invitee, not a guest, but the payload still carries the address
  // under `guestEmail` (see that module's own `inviteUser` note on why).
  'staff.invited': 'staff_invitation',
  // Gap closure (feature-dev): guest password-reset — the genuine, intended
  // use of `guestEmail`, unlike `staff.invited`'s borrowed one.
  'guest.password_reset_requested': 'guest_password_reset',
  // Gap closure (user-reported): a real staff MFA login code — the
  // recipient is staff, not a guest, the same borrowed-field reuse
  // `staff.invited` already established.
  'staff.mfa_code_requested': 'staff_mfa_code',
  // PLAN.md Phase 4 (Accounts Receivable) — the recipient is a company's own
  // billing contact, not a guest at all. Rather than borrowing `guestEmail`
  // a third time, these two events use the new, correctly-named
  // `recipientEmail` payload key instead (see `dispatchOne`'s own comment
  // below) — a real fix, not a further instance of the same borrowed-field
  // pattern.
  'ar.invoice_generated': 'ar_invoice_generated',
  'ar.payment_received': 'ar_payment_received',
  // PLAN.md Phase 5 (subscription billing dunning) — the recipient is the
  // tenant's own billing contact, not a guest or a company. Uses the same
  // `recipientEmail` payload key `ar.*` above already established, since
  // this is the identical "not a guest at all" shape. `billing.payment_failed`
  // covers every escalating retry-stage notification (the urgency itself
  // is DATA the payload carries — `urgencyLabel`/`message` — not a
  // separate template per stage); `billing.subscription_suspended` is the
  // final, distinct notice once the retry schedule is exhausted.
  'billing.payment_failed': 'billing_payment_failed',
  'billing.subscription_suspended': 'billing_subscription_suspended',
  // PLAN.md Phase 6 (QR self-ordering gap closure) — neither recipient is a
  // guest ACCOUNT (no login exists on this fully anonymous surface), so
  // both use the same `recipientEmail` payload key `ar.*`/`billing.*`
  // already established rather than a further instance of `guestEmail`'s
  // borrowed-field pattern. `pos.room_charge_otp_requested`'s recipient is
  // the IN-HOUSE RESERVATION's own registered email, never a guest-typed
  // contact (this session's confirmed decision). `pos.guest_order_receipt`'s
  // recipient is whatever contact the guest optionally supplied at order
  // time — genuinely absent for a large share of orders, in which case
  // `dispatchOne`'s existing "not an email-worthy event" fallthrough marks
  // it sent with nothing to deliver, exactly like any other event with no
  // resolvable recipient.
  'pos.room_charge_otp_requested': 'pos_room_charge_otp',
  'pos.guest_order_receipt': 'pos_guest_order_receipt',
  // PLAN.md Phase 7 (door access monitoring) — one digest per manager/admin/
  // super_admin per lock-log import that raised critical alerts; recipient
  // is staff, so `recipientEmail` like `ar.*`/`billing.*`.
  'door_access.critical_alerts_detected': 'door_access_critical_alerts',
};

/**
 * Built-in fallback content — used when a property has not configured its
 * own `email_templates` row for a key yet, so a send is never silently
 * dropped for want of a template (this table's own migration header).
 * `{{var}}` placeholders, substituted (HTML-escaped) against the event
 * payload plus `propertyName`. Written like a hotel's own correspondence and
 * built from `email-layout.js`'s helpers; every message — default or
 * property-configured — is then wrapped in the branded shell with the
 * property's logo (`composeEmail`).
 */
const DEFAULT_TEMPLATES = {
  reservation_confirmed: {
    subject: 'Your stay at {{propertyName}} is confirmed — {{confirmationNumber}}',
    body_html:
      heading('Your stay is confirmed') +
      paragraph('Dear {{guestName}},') +
      paragraph('Thank you for choosing {{propertyName}}. We are delighted to confirm your reservation and look forward to welcoming you.') +
      details([
        ['Confirmation number', '{{confirmationNumber}}'],
        ['Arrival', '{{arrivalDate}}'],
        ['Departure', '{{departureDate}}'],
      ]) +
      note('Need to change your plans? Reply to this email or contact our front desk, quoting your confirmation number.'),
  },
  reservation_cancelled: {
    subject: 'Your reservation at {{propertyName}} has been cancelled — {{confirmationNumber}}',
    body_html:
      heading('Your reservation has been cancelled') +
      paragraph('Dear {{guestName}},') +
      paragraph('As requested, your reservation at {{propertyName}} has been cancelled.') +
      details([
        ['Confirmation number', '{{confirmationNumber}}'],
        ['Original arrival', '{{arrivalDate}}'],
        ['Original departure', '{{departureDate}}'],
      ]) +
      note('If you did not ask for this cancellation, please contact us straight away. We hope to welcome you another time.'),
  },
  checked_in: {
    subject: 'Welcome to {{propertyName}}',
    body_html:
      heading('Welcome to {{propertyName}}') +
      paragraph('Dear {{guestName}},') +
      paragraph('You are checked in and your room is ready. We hope you have a wonderful stay.') +
      details([
        ['Room', '{{roomNumber}}'],
        ['Check-out', '{{departureDate}}'],
        ['Confirmation number', '{{confirmationNumber}}'],
      ]) +
      note('Anything you need during your stay, our front desk is happy to help.'),
  },
  checked_out: {
    subject: 'Thank you for staying at {{propertyName}}',
    body_html:
      heading('Thank you for staying with us') +
      paragraph('Dear {{guestName}},') +
      paragraph('It was a pleasure having you at {{propertyName}}. You have now been checked out — we hope you had a comfortable stay.') +
      details([
        ['Confirmation number', '{{confirmationNumber}}'],
        ['Stay', '{{arrivalDate}} – {{departureDate}}'],
        ['Final balance', '{{folioBalance}}'],
      ]) +
      note('We would love to welcome you back soon.'),
  },
  staff_invitation: {
    subject: "You're invited to join {{propertyName}} on LodgeKeep",
    body_html:
      heading('You are invited to join {{propertyName}}') +
      paragraph('You have been invited to join the {{propertyName}} team on LodgeKeep as {{role}}.') +
      button('{{invitationUrl}}', 'Set up your account') +
      note('If you were not expecting this invitation, you can safely ignore this email.'),
  },
  guest_password_reset: {
    subject: 'Reset your password — {{propertyName}}',
    body_html:
      heading('Reset your password') +
      paragraph('We received a request to reset the password for your {{propertyName}} guest account.') +
      button('{{resetUrl}}', 'Reset your password') +
      note('This link expires in {{expiresInHours}} hour(s). If you did not request a reset, you can safely ignore this email — your password will not change.'),
  },
  staff_mfa_code: {
    subject: 'Your LodgeKeep verification code',
    body_html:
      heading('Your verification code') +
      paragraph('Use this code to finish signing in to LodgeKeep:') +
      codeBlock('{{code}}') +
      note('This code expires in {{expiresInMinutes}} minute(s). If you did not try to sign in, you can safely ignore this email.'),
  },
  ar_invoice_generated: {
    subject: 'Invoice {{invoiceNumber}} from {{propertyName}}',
    body_html:
      heading('New invoice {{invoiceNumber}}') +
      paragraph('Dear {{companyName}},') +
      paragraph('A new invoice from {{propertyName}} is ready.') +
      details([
        ['Invoice number', '{{invoiceNumber}}'],
        ['Amount due', '{{totalAmount}} {{currency}}'],
        ['Due date', '{{dueAt}}'],
      ]) +
      note('Please arrange payment by the due date, quoting the invoice number.'),
  },
  ar_payment_received: {
    subject: 'Payment received — thank you',
    body_html:
      heading('Payment received — thank you') +
      paragraph('Dear {{companyName}},') +
      paragraph('We have received and recorded your payment. Thank you for settling your account with {{propertyName}}.') +
      details([['Amount received', '{{amount}} {{currency}}']]) +
      note('Please keep this email for your records.'),
  },
  billing_payment_failed: {
    subject: '{{urgencyLabel}}: your {{tenantName}} subscription payment failed',
    body_html:
      heading('{{urgencyLabel}}') +
      paragraph('{{message}}') +
      details([
        ['Amount due', '{{amount}} {{currency}}'],
        ['Next automatic retry', '{{nextRetryDate}}'],
      ]) +
      note('Your account remains fully usable while this is being resolved — updating your payment method before the retry schedule ends restores normal billing immediately.'),
  },
  billing_subscription_suspended: {
    subject: 'Your {{tenantName}} subscription has been suspended',
    body_html:
      heading('Your subscription has been suspended') +
      paragraph('After {{attemptCount}} failed payment attempts over the last two weeks, your account has been suspended for non-payment.') +
      paragraph('Your data is safe and untouched — this only pauses new bookings and other changes; nothing already in your account is lost or hidden.') +
      note('Add a valid payment method to restore full access immediately.'),
  },
  pos_room_charge_otp: {
    subject: 'Confirm your room charge — {{propertyName}}',
    body_html:
      heading('Confirm your room charge') +
      paragraph('An order at {{propertyName}} is asking to be charged to your room. Enter this code to confirm it:') +
      codeBlock('{{code}}') +
      note('This code expires in {{expiresInMinutes}} minute(s). If you did not place this order, you can safely ignore this email.'),
  },
  pos_guest_order_receipt: {
    subject: 'Your receipt from {{propertyName}}',
    body_html:
      heading('Thank you for your order') +
      paragraph('Your order at {{propertyName}} has been paid.') +
      details([['Total charged', '{{amount}} {{currency}}']]) +
      note('Please keep this email as your receipt.'),
  },
  door_access_critical_alerts: {
    subject: 'Door access: {{criticalAlertCount}} critical alert(s) found in a lock log import — {{propertyName}}',
    body_html:
      heading('Critical door-access alerts') +
      paragraph('Dear {{recipientName}},') +
      paragraph('A lock audit trail uploaded at {{propertyName}} raised {{criticalAlertCount}} critical alert(s).') +
      paragraph('These were found retrospectively. The door events happened between {{earliestEventDate}} and {{latestEventDate}} and were only detected when the lock log was uploaded — this is not real-time monitoring.') +
      details([
        ['Alerts', '{{alertSummary}}'],
        ['Door events imported', '{{importedEventCount}}'],
      ]) +
      note('Review the evidence and acknowledge or resolve each alert under Door Access.'),
  },
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/;

/** A payload date ("2026-09-13") as guests read it ("Sun, 13 Sep 2026"); anything else unchanged. */
function formatValue(value) {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * `{{var}}` substitution. In HTML every value is escaped, so a guest or
 * company name can never inject markup; subjects are plain text. A
 * placeholder with no value renders empty rather than as raw `{{braces}}`.
 */
function substitute(template, variables, { escape }) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    const text = String(formatValue(value));
    return escape ? escapeHtml(text) : text;
  });
}

/** Property-configured template if one exists, else the built-in default (never neither). */
async function renderTemplate({ db, propertyId, templateKey, variables }) {
  const row = await db.table('email_templates').where({ property_id: propertyId, template_key: templateKey, locale: 'en' }).first();
  const base = row ?? DEFAULT_TEMPLATES[templateKey];
  if (!base) throw new Error(`No template (configured or built-in) for key "${templateKey}".`);
  return { subject: substitute(base.subject, variables, { escape: false }), html: substitute(base.body_html, variables, { escape: true }) };
}

/**
 * A ready-to-send email: the template rendered against the payload, wrapped
 * in the property's branded shell, with its logo as an inline attachment.
 * Every path that sends a templated email goes through this, so no message
 * ever leaves unbranded.
 */
async function composeEmail({ db, propertyId, templateKey, variables }) {
  const branding = await loadEmailBranding({ db, propertyId });
  const withProperty = { ...variables, propertyName: variables.propertyName || branding.name || '' };
  const { subject, html } = await renderTemplate({ db, propertyId, templateKey, variables: withProperty });
  return {
    subject,
    html: renderEmailShell({ subject, contentHtml: html, branding, preheader: preheaderFrom(html) }),
    attachments: branding.logoAttachment ? [branding.logoAttachment] : [],
  };
}

/**
 * One outbox event, dispatched — the unit `dispatchPendingOutboxEventsForTenant`
 * loops over. `tenantDb` (bound to the tenant only) owns `outbox_events`
 * (TENANT_SCOPED); `propertyDb` (bound to this specific event's own
 * `property_id`) owns `email_templates`/`notification_log` (PROPERTY_SCOPED)
 * — a tenant with more than one property can have pending events for
 * DIFFERENT properties in the same sweep, and the scoped accessor's
 * PROPERTY_SCOPED predicate is fixed per context, so one event's dispatch
 * must not reuse another event's property context (see
 * `dispatchPendingOutboxEventsForTenant`'s own grouping for why).
 */
async function dispatchOne({ tenantDb, propertyDb, event }) {
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
  const templateKey = EVENT_TEMPLATE_KEYS[event.event_type];
  // PLAN.md Phase 4 (Accounts Receivable): `recipientEmail` is the
  // correctly-named payload key `ar.invoice_generated`/`ar.payment_received`
  // use — a company's own billing contact, never a guest at all. Falls
  // back to `guestEmail` so every existing event (`staff.invited`,
  // `staff.mfa_code_requested`, the guest-lifecycle events) is completely
  // unaffected — none of them are touched or need to be.
  const recipientEmail = payload.recipientEmail ?? payload.guestEmail;

  if (!templateKey || !recipientEmail || !propertyDb) {
    // Not an email-worthy event (or malformed payload, or no property to
    // dispatch against) — mark sent so it never wedges the queue; nothing
    // to deliver.
    await tenantDb.table('outbox_events').where({ id: event.id }).update({ status: 'sent', processed_at: new Date() });
    return;
  }

  try {
    const { subject, html, attachments } = await composeEmail({ db: propertyDb, propertyId: event.property_id, templateKey, variables: payload });
    // Gap closure: "add the mail setup on in SETUP menu" — a property's own
    // email_settings row, when configured, overrides the process-level
    // adapter, the same override-else-default shape `renderTemplate` above
    // already uses for the template content itself.
    const adapter = await resolveEmailAdapter({ db: propertyDb, propertyId: event.property_id });
    const { providerRef, status } = await adapter.send({ to: recipientEmail, subject, html, attachments });

    await propertyDb.table('notification_log').insert({
      recipient_email: recipientEmail,
      template_key: templateKey,
      channel: 'email',
      status,
      provider_ref: providerRef,
      reservation_id: payload.reservationId ?? null,
      sent_at: new Date(),
    });
    await tenantDb.table('outbox_events').where({ id: event.id }).update({ status: 'sent', processed_at: new Date(), attempt_count: event.attempt_count + 1 });
  } catch (error) {
    const attemptCount = event.attempt_count + 1;
    const exhausted = attemptCount >= MAX_ATTEMPTS;
    await tenantDb.table('outbox_events').where({ id: event.id }).update({
      status: exhausted ? 'failed' : 'pending',
      attempt_count: attemptCount,
      last_error: String(error?.message ?? error).slice(0, 2000),
    });
    if (exhausted) {
      await propertyDb.table('notification_log').insert({
        recipient_email: recipientEmail,
        template_key: templateKey,
        channel: 'email',
        status: 'failed',
        failed_reason: String(error?.message ?? error).slice(0, 2000),
        reservation_id: payload.reservationId ?? null,
      });
    }
  }
}

/**
 * Processes up to `limit` pending events for one tenant — ARCHITECTURE.md
 * §14: "every job carries tenant_id," so a dispatch run is always scoped to
 * one tenant, never a cross-tenant sweep through the accessor (there is no
 * such query path — see `src/jobs/outbox-dispatcher.js`'s own header for how
 * tenants are enumerated one level up, outside this function).
 *
 * `outbox_events` is read tenant-wide (TENANT_SCOPED — `context.propertyId`
 * plays no part in that read), then grouped by each event's OWN
 * `property_id` before dispatch: a tenant with more than one property can
 * have pending events belonging to different properties in the same sweep,
 * and every PROPERTY_SCOPED write the dispatch does (`email_templates`
 * lookup, `notification_log` insert) must run under a context bound to
 * THAT event's property, not whichever property happened to be passed in.
 */
async function dispatchPendingOutboxEventsForTenant({ context, limit = 50 }) {
  const tenantDb = scopedDb().for(context);
  const events = await tenantDb.table('outbox_events').where({ status: 'pending' }).orderBy('created_at').limit(limit);

  const propertyDbCache = new Map();
  function propertyDbFor(propertyId) {
    if (!propertyId) return null;
    if (!propertyDbCache.has(propertyId)) {
      propertyDbCache.set(propertyId, scopedDb().for(workerContext({ tenantId: context.tenantId, propertyId })));
    }
    return propertyDbCache.get(propertyId);
  }

  for (const event of events) {
    await dispatchOne({ tenantDb, propertyDb: propertyDbFor(event.property_id), event });
  }
  return events.length;
}

// ---------------------------------------------------------------------
// Templates (admin editor)
// ---------------------------------------------------------------------

async function listTemplates({ context }) {
  const db = scopedDb().for(context);
  return db.table('email_templates').orderBy('template_key');
}

/** Upsert by (property_id, template_key, locale) — the same lazy insert-or-update shape `configureOverbookingThreshold` uses. */
async function upsertTemplate({ context, templateKey, locale = 'en', subject, bodyHtml }) {
  const db = scopedDb().for(context);
  const existing = await db.table('email_templates').where({ template_key: templateKey, locale }).first();
  if (existing) {
    await db.table('email_templates').where({ id: existing.id }).update({ subject, body_html: bodyHtml });
  } else {
    await db.table('email_templates').insert({ template_key: templateKey, locale, subject, body_html: bodyHtml });
  }
  return db.table('email_templates').where({ template_key: templateKey, locale }).first();
}

// ---------------------------------------------------------------------
// Delivery log — PRODUCT_REQUIREMENTS.md §3.21's "the guest never got it" answer
// ---------------------------------------------------------------------

/** Allow-listed filters (API.md's own rule): recipient, template, status. */
async function listNotificationLog({ context, recipientEmail, templateKey, status }) {
  const db = scopedDb().for(context);
  let query = db.table('notification_log');
  if (recipientEmail) query = query.where('recipient_email', recipientEmail);
  if (templateKey) query = query.where({ template_key: templateKey });
  if (status) query = query.where({ status });
  return query.orderBy('created_at', 'desc');
}

async function getNotificationLogEntry({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('notification_log').where({ id }).first();
}

/** A fresh send attempt reusing the failed row's own recipient/template/reservation — a new log row, the failed one stays as its own historical record (financial-record-style immutability is not required here, but "never silently replace a record of what happened" is the same instinct). */
async function resendNotification({ context, id }) {
  const db = scopedDb().for(context);
  const failed = await db.table('notification_log').where({ id }).first();
  if (!failed) return null;

  const reservation = failed.reservation_id ? await db.table('reservations').where({ id: failed.reservation_id }).first() : null;
  const guest = reservation ? await db.table('guests').where({ id: reservation.guest_id }).first() : null;
  const variables = {
    guestEmail: failed.recipient_email,
    guestName: guest ? `${guest.first_name} ${guest.last_name}` : failed.recipient_email,
    confirmationNumber: reservation?.confirmation_number ?? '',
    arrivalDate: reservation?.arrival_date ?? '',
    departureDate: reservation?.departure_date ?? '',
  };

  const { subject, html, attachments } = await composeEmail({ db, propertyId: reservation?.property_id ?? context.propertyId, templateKey: failed.template_key, variables });
  // Consistency with `dispatchOne`: a resend honors the same property-level
  // `email_settings` override, not silently the process-level default.
  const adapter = await resolveEmailAdapter({ db, propertyId: context.propertyId });
  const { providerRef, status } = await adapter.send({ to: failed.recipient_email, subject, html, attachments });

  const [newId] = await db.table('notification_log').insert({
    recipient_email: failed.recipient_email,
    template_key: failed.template_key,
    channel: 'email',
    status,
    provider_ref: providerRef,
    reservation_id: failed.reservation_id,
    sent_at: new Date(),
  });
  return db.table('notification_log').where({ id: newId }).first();
}

// ---------------------------------------------------------------------
// In-app bell
// ---------------------------------------------------------------------

async function listInAppNotifications({ context, userId, unreadOnly }) {
  const db = scopedDb().for(context);
  let query = db.table('in_app_notifications').where({ user_id: userId });
  if (unreadOnly) query = query.whereNull('read_at');
  // Bounded: the bell is polled every few seconds by every signed-in staff
  // member, and a busy property now produces many rows a day.
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(BELL_LIMIT);
}

/** How many unread notifications this user holds in total — the badge count, independent of `BELL_LIMIT`. */
async function countUnreadNotifications({ context, userId }) {
  const db = scopedDb().for(context);
  return db.table('in_app_notifications').where({ user_id: userId }).whereNull('read_at').count();
}

async function markAllNotificationsRead({ context, userId }) {
  const db = scopedDb().for(context);
  return db.table('in_app_notifications').where({ user_id: userId }).whereNull('read_at').update({ read_at: new Date() });
}

function listNotificationCatalogue() {
  return NOTIFICATION_EVENTS.map(({ eventType, group, label, description, defaultRoles }) => ({
    eventType,
    group,
    label,
    description,
    defaultRoles,
  }));
}

async function listNotificationRoleRules({ context }) {
  return staffNotifications.listRoleRules({ db: scopedDb().for(context) });
}

async function saveNotificationRoleRules({ context, rules }) {
  return staffNotifications.saveRoleRules({ db: scopedDb().for(context), rules });
}

async function markNotificationRead({ context, id, userId }) {
  const db = scopedDb().for(context);
  const notification = await db.table('in_app_notifications').where({ id, user_id: userId }).first();
  if (!notification) return null;
  await db.table('in_app_notifications').where({ id }).update({ read_at: new Date() });
  return db.table('in_app_notifications').where({ id }).first();
}

/**
 * Whether an outbox email genuinely reaches a real inbox right now — the
 * `console` adapter (the default with no `EMAIL_PROVIDER` configured, and
 * no property-level `email_settings` override) never does. Other modules
 * use this to decide whether a "dev-only" disclosure (a code/token also
 * returned directly in the API response, outside production, for local
 * testing with no real inbox) is still honest to show — once a real
 * adapter is wired up, the whole reason that disclosure existed is gone,
 * and showing it alongside a genuinely working email would defeat the
 * point of sending the email at all.
 *
 * `propertyId`/`db` are both optional, matching `resolveEmailAdapter`'s own
 * guard — omit both to check only the process-level default (the shape
 * every caller used before the per-property `email_settings` gap closure).
 */
async function isEmailDeliveryReal({ db, propertyId } = {}) {
  const adapter = await resolveEmailAdapter({ db, propertyId });
  return adapter.name !== 'console';
}

module.exports = {
  composeEmail,
  EVENT_TEMPLATE_KEYS,
  dispatchPendingOutboxEventsForTenant,
  isEmailDeliveryReal,
  listTemplates,
  upsertTemplate,
  listNotificationLog,
  getNotificationLogEntry,
  resendNotification,
  listInAppNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listNotificationCatalogue,
  listNotificationRoleRules,
  saveNotificationRoleRules,
};
