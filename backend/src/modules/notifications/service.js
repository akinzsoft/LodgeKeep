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

const MAX_ATTEMPTS = 5;

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
};

/**
 * Built-in fallback content — used when a property has not configured its
 * own `email_templates` row for a key yet, so a send is never silently
 * dropped for want of a template (this table's own migration header).
 * `{{var}}` placeholders, substituted against the event payload.
 */
const DEFAULT_TEMPLATES = {
  reservation_confirmed: {
    subject: 'Your reservation is confirmed — {{confirmationNumber}}',
    body_html: '<p>Hi {{guestName}},</p><p>Your reservation ({{confirmationNumber}}) for {{arrivalDate}} to {{departureDate}} is confirmed.</p>',
  },
  reservation_cancelled: {
    subject: 'Your reservation has been cancelled — {{confirmationNumber}}',
    body_html: '<p>Hi {{guestName}},</p><p>Your reservation ({{confirmationNumber}}) has been cancelled.</p>',
  },
  checked_in: {
    subject: 'Welcome — you are checked in',
    body_html: '<p>Hi {{guestName}},</p><p>You are checked into room {{roomNumber}}. Enjoy your stay.</p>',
  },
  checked_out: {
    subject: 'Thank you for staying with us',
    body_html: '<p>Hi {{guestName}},</p><p>You have been checked out. Your final folio balance was {{folioBalance}}.</p>',
  },
  staff_invitation: {
    subject: "You're invited to join {{propertyName}} on LodgeKeep",
    body_html: '<p>You have been invited to join {{propertyName}} as {{role}}.</p><p><a href="{{invitationUrl}}">Set up your account</a></p>',
  },
  guest_password_reset: {
    subject: 'Reset your password — {{propertyName}}',
    body_html:
      '<p>We received a request to reset your password for your account at {{propertyName}}.</p>' +
      '<p><a href="{{resetUrl}}">Reset your password</a></p>' +
      '<p>This link expires in {{expiresInHours}} hour(s). If you did not request this, you can safely ignore this email.</p>',
  },
  staff_mfa_code: {
    subject: 'Your LodgeKeep verification code',
    body_html:
      '<p>Your verification code is:</p>' +
      '<p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">{{code}}</p>' +
      '<p>This code expires in {{expiresInMinutes}} minute(s). If you did not attempt to sign in, you can safely ignore this email.</p>',
  },
  ar_invoice_generated: {
    subject: 'New invoice {{invoiceNumber}}',
    body_html: '<p>Hi {{companyName}},</p><p>A new invoice ({{invoiceNumber}}) for {{totalAmount}} {{currency}} has been generated, due {{dueAt}}.</p>',
  },
  ar_payment_received: {
    subject: 'Payment received — thank you',
    body_html: '<p>Hi {{companyName}},</p><p>We have recorded your payment of {{amount}} {{currency}}. Thank you.</p>',
  },
};

function substitute(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (variables[key] !== undefined ? String(variables[key]) : match));
}

/** Property-configured template if one exists, else the built-in default (never neither). */
async function renderTemplate({ db, propertyId, templateKey, variables }) {
  const row = await db.table('email_templates').where({ property_id: propertyId, template_key: templateKey, locale: 'en' }).first();
  const base = row ?? DEFAULT_TEMPLATES[templateKey];
  if (!base) throw new Error(`No template (configured or built-in) for key "${templateKey}".`);
  return { subject: substitute(base.subject, variables), html: substitute(base.body_html, variables) };
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
    const { subject, html } = await renderTemplate({ db: propertyDb, propertyId: event.property_id, templateKey, variables: payload });
    // Gap closure: "add the mail setup on in SETUP menu" — a property's own
    // email_settings row, when configured, overrides the process-level
    // adapter, the same override-else-default shape `renderTemplate` above
    // already uses for the template content itself.
    const adapter = await resolveEmailAdapter({ db: propertyDb, propertyId: event.property_id });
    const { providerRef, status } = await adapter.send({ to: recipientEmail, subject, html });

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

  const { subject, html } = await renderTemplate({ db, propertyId: reservation?.property_id, templateKey: failed.template_key, variables });
  // Consistency with `dispatchOne`: a resend honors the same property-level
  // `email_settings` override, not silently the process-level default.
  const adapter = await resolveEmailAdapter({ db, propertyId: context.propertyId });
  const { providerRef, status } = await adapter.send({ to: failed.recipient_email, subject, html });

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
  return query.orderBy('created_at', 'desc');
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
  EVENT_TEMPLATE_KEYS,
  dispatchPendingOutboxEventsForTenant,
  isEmailDeliveryReal,
  listTemplates,
  upsertTemplate,
  listNotificationLog,
  getNotificationLogEntry,
  resendNotification,
  listInAppNotifications,
  markNotificationRead,
};
