'use strict';

/**
 * Manual (cash / bank transfer / other) subscriptions, recorded from the platform console.
 *
 *   markSubscribed   trial|suspended -> active, once. Records the payment, sets the tenant's plan, moves it to its
 *                    SUBSCRIBED domain, and queues one e-mail per active user.
 *   recordPayment    an already-active manually-paid tenant paid again: extends the paid-until date and sends a receipt to
 *                    its super_admins. Never changes the tenant's status or domain.
 *   listExpiring     manually-paid subscriptions whose paid-until date is near or past. A LIST, not an action: NOTHING in
 *                    this codebase suspends a manually-paid tenant when its period ends (see below).
 *
 * A manual payment is stored as the SAME rows a card payment is (a `subscriptions` row, a paid `subscription_invoices` row,
 * a CAPTURED `subscription_payments` row with provider 'manual'), so the roster, the tenant's Billing screen and the invoice
 * history treat both alike. `manual_payment_records` adds only what those tables have no column for (method, reference note,
 * paid-until, who recorded it).
 *
 * WHY THE BILLING SWEEPS MUST SKIP MANUAL SUBSCRIPTIONS: `subscription-billing.js` charges every non-canceled subscription
 * whose period has arrived, and `processTenantBillingCycle` would run the dunning schedule against a card that does not
 * exist and suspend the tenant. A manual subscription has `payment_method_provider = 'manual'`, which both skip. The trial
 * sweep already ignores any tenant with a subscription row. Tenants on a Paystack card are refused here.
 *
 * Everything the client sends is validated here; the plan is looked up by code, the currency must equal the plan's, and
 * nothing the client sends decides the status, the domain or an id.
 */

const { scopedDb } = require('../../db');
const { workerContext } = require('../tenancy');
const { recordAuditEntry } = require('../../audit');
const { ValidationError, AppError } = require('../../shared/errors');
const { lifecycleDomains, tenantBaseUrlFor } = require('../../shared/app-domains');
const { queueLifecycleEmails } = require('../../shared/tenant-lifecycle-emails');
const { TenantNotFoundError, InvalidTenantLifecycleTransitionError, assertNotPurging } = require('./errors');

const METHODS = Object.freeze(['cash', 'bank_transfer', 'other']);
const MAX_PAID_UNTIL_DAYS = 400;
const MAX_AMOUNT = 1_000_000_000;
const MS_PER_DAY = 86_400_000;
const DEFAULT_EXPIRING_WINDOW_DAYS = 14;

class ManualSubscriptionRefusedError extends AppError {
  constructor(code, message) {
    super(`BUSINESS_RULE_${code}`, message, 409);
  }
}

function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  return new Date(Date.parse(`${dateString}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function bad(field, issue, message) {
  return new ValidationError(`INVALID_${field.toUpperCase()}`, message, [{ field, issue }]);
}

/** Pure: validates and normalises a manual-payment request. `plan` is the server-resolved plan row (or null). Throws ValidationError. */
function validateManualPayment(input, { plan, today }) {
  const body = input ?? {};
  const planCode = typeof body.plan_code === 'string' ? body.plan_code.trim() : '';
  if (!planCode) throw bad('plan_code', 'missing', '"plan_code" is required.');
  if (!plan) throw bad('plan_code', 'unknown', `There is no active plan "${planCode}".`);

  if (!METHODS.includes(body.method)) throw bad('method', 'invalid', `"method" must be one of: ${METHODS.join(', ')}.`);

  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  if (reference.length < 3 || reference.length > 100) throw bad('reference', 'invalid', '"reference" (the receipt or transfer reference) must be 3 to 100 characters.');

  const amountText = typeof body.amount === 'string' ? body.amount.trim() : '';
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(amountText) || Number(amountText) <= 0 || Number(amountText) > MAX_AMOUNT) {
    throw bad('amount', 'invalid', '"amount" must be a positive amount as text with at most 2 decimals, for example "50000.00".');
  }
  const [whole, fraction = ''] = amountText.split('.');
  const amount = `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;

  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('currency', 'invalid', '"currency" must be a 3-letter ISO code.');
  if (currency !== plan.currency) throw bad('currency', 'mismatch', `The payment currency must be the plan's currency (${plan.currency}).`);

  if (!isRealDate(body.paid_until)) throw bad('paid_until', 'invalid', '"paid_until" must be a real date as YYYY-MM-DD.');
  if (body.paid_until <= today) throw bad('paid_until', 'past', '"paid_until" must be after today.');
  if (body.paid_until > addDays(today, MAX_PAID_UNTIL_DAYS)) throw bad('paid_until', 'too_far', `"paid_until" cannot be more than ${MAX_PAID_UNTIL_DAYS} days ahead.`);

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw bad('reason', 'missing', '"reason" is required.');

  return { planCode, method: body.method, reference, amount, currency, paidUntil: body.paid_until, reason: reason.slice(0, 255) };
}

async function lockTenant(db, tenantId) {
  const tenant = await db.platformDirectory().table('tenants').where({ id: tenantId }).forUpdate().first();
  if (!tenant) throw new TenantNotFoundError();
  assertNotPurging(tenant);
  return tenant;
}

/** Writes the invoice, the CAPTURED payment and the manual record; returns the payment id. */
async function writePaymentRows(db, { tenantId, subscriptionId, plan, valid, periodStart, kind, platformUserId, now }) {
  const used = await db.platform().table('subscription_payments').where({ provider: 'manual', provider_reference: valid.reference }).first('id');
  if (used) throw new ManualSubscriptionRefusedError('REFERENCE_ALREADY_USED', 'That payment reference has already been recorded.');
  let invoiceId;
  try {
    [invoiceId] = await db.platform().table('subscription_invoices').insert({
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      amount: valid.amount,
      currency: valid.currency,
      status: 'paid',
      period_start: periodStart,
      period_end: valid.paidUntil,
      due_at: periodStart,
      paid_at: now,
    });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw new ManualSubscriptionRefusedError('PERIOD_ALREADY_RECORDED', 'A payment for a period starting on this date is already recorded.');
    throw error;
  }
  let paymentId;
  try {
    [paymentId] = await db.platform().table('subscription_payments').insert({
      tenant_id: tenantId,
      subscription_invoice_id: invoiceId,
      idempotency_key: `manual:${valid.reference}`,
      provider: 'manual',
      provider_reference: valid.reference,
      amount: valid.amount,
      currency: valid.currency,
      status: 'CAPTURED',
      captured_at: now,
    });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw new ManualSubscriptionRefusedError('REFERENCE_ALREADY_USED', 'That payment reference has already been recorded.');
    throw error;
  }
  await db.platform().table('manual_payment_records').insert({
    tenant_id: tenantId,
    subscription_payment_id: paymentId,
    plan_id: plan.id,
    kind,
    method: valid.method,
    reference_note: valid.reference,
    paid_until: valid.paidUntil,
    recorded_by_platform_user_id: platformUserId ?? null,
  });
  return paymentId;
}

function paymentSummary(valid, plan) {
  return { planName: plan.name, amount: valid.amount, currency: valid.currency, method: valid.method.replace('_', ' '), reference: valid.reference, paidUntil: valid.paidUntil };
}

async function enqueueDelivery(tenantId, propertyIds) {
  try {
    const { enqueueOutboxDispatch } = require('../../jobs/outbox-dispatcher');
    for (const propertyId of propertyIds) await enqueueOutboxDispatch({ tenantId, propertyId });
  } catch (error) {
    console.error('[subscribe] could not enqueue e-mail dispatch (the periodic sweep will deliver):', error?.message);
  }
}

async function markSubscribed({ context, tenantId, input, ip, userAgent, requestId }) {
  const now = new Date();
  const today = utcToday(now);
  const result = await scopedDb().for(context).transaction(async (db) => {
    const tenant = await lockTenant(db, tenantId);
    const existing = await db.platform().table('subscriptions').where({ tenant_id: tenantId }).forUpdate().first();
    if (existing && (existing.payment_method_provider !== 'manual' || existing.payment_method_authorization_code)) {
      throw new ManualSubscriptionRefusedError('TENANT_HAS_CARD_SUBSCRIPTION', 'This tenant has a card (Paystack) subscription on file, so billing controls it. A manual payment cannot be recorded for it.');
    }
    // The double-click / retry guard: only a trial or suspended tenant can be marked subscribed, and only once.
    if (!['trial', 'suspended'].includes(tenant.status)) throw new InvalidTenantLifecycleTransitionError(tenant.status, 'active');

    const planCode = typeof input?.plan_code === 'string' ? input.plan_code.trim() : '';
    const plan = planCode ? await db.reference().table('plans').where({ code: planCode, is_active: true }).first() : null;
    const valid = validateManualPayment(input, { plan, today });

    let subscriptionId;
    const periodFields = { plan_id: plan.id, status: 'active', current_period_start: today, current_period_end: valid.paidUntil, consecutive_failed_attempts: 0, payment_method_provider: 'manual' };
    if (existing) {
      await db.platform().table('subscriptions').where({ id: existing.id }).update(periodFields);
      subscriptionId = existing.id;
    } else {
      [subscriptionId] = await db.platform().table('subscriptions').insert({ tenant_id: tenantId, ...periodFields });
    }

    const paymentId = await writePaymentRows(db, { tenantId, subscriptionId, plan, valid, periodStart: today, kind: 'subscribe', platformUserId: context.platformUserId, now });

    const lifecycle = db.platformTenantLifecycle();
    const domain = lifecycleDomains().subscribed;
    const updated = await lifecycle.changeStatus(tenantId, ['trial', 'suspended'], {
      status: 'active',
      plan_id: plan.id,
      app_domain: domain,
      subscribed_at: tenant.subscribed_at ?? now,
    });
    if (!updated) throw new InvalidTenantLifecycleTransitionError(tenant.status, 'active');

    const tenantDb = lifecycle.withContext(workerContext({ tenantId }));
    await recordAuditEntry(tenantDb, {
      entityType: 'tenants',
      entityId: tenantId,
      action: 'mark_subscribed',
      source: 'api',
      beforeState: { status: tenant.status, app_domain: tenant.app_domain ?? null },
      afterState: { status: 'active', app_domain: domain, plan: plan.code, method: valid.method, reference: valid.reference, amount: valid.amount, currency: valid.currency, paid_until: valid.paidUntil, subscription_payment_id: String(paymentId) },
      reason: valid.reason,
      requestId,
      ipAddress: ip,
      userAgent,
    });

    const after = { ...tenant, app_domain: domain };
    const emails = await queueLifecycleEmails({
      platformDb: db,
      tenantDb,
      tenant: after,
      kindKey: 'subscribed',
      eventType: 'tenant.subscribed',
      payload: paymentSummary(valid, plan),
    });
    return { tenantId: String(tenantId), status: 'active', appDomain: domain, loginUrl: tenantBaseUrlFor(after), paidUntil: valid.paidUntil, emails, subscriptionPaymentId: String(paymentId) };
  });
  await enqueueDelivery(tenantId, result.emails.propertyIds);
  const { propertyIds, ...emails } = result.emails;
  return { ...result, emails };
}

/**
 * Moves an ACTIVE tenant to the SUBSCRIBED domain and e-mails every active user the new address. Touches `tenants.app_domain`
 * and nothing else: not the status, not the subscription, not any billing row. Never runs by itself.
 *
 * Refused: any status but `active` (so purging, purged, offboarding, suspended and trial tenants are all refused), an unset
 * SUBSCRIBED_APP_DOMAIN (it would silently equal the primary), and a tenant already on that domain (which also makes a repeat
 * click harmless: nothing is changed and nothing is sent; the unique (tenant, kind, user) rows are the second guard).
 */
async function moveToNewDomain({ context, tenantId, reason, ip, userAgent, requestId }) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw bad('reason', 'missing', '"reason" is required.');
  if (!String(process.env.SUBSCRIBED_APP_DOMAIN ?? '').trim()) {
    throw new AppError('BUSINESS_RULE_SUBSCRIBED_DOMAIN_NOT_SET', 'SUBSCRIBED_APP_DOMAIN is not set on the server, so there is no new domain to move this tenant to.', 422);
  }
  const target = lifecycleDomains().subscribed;

  const result = await scopedDb().for(context).transaction(async (db) => {
    const tenant = await lockTenant(db, tenantId);
    if (tenant.status !== 'active') throw new InvalidTenantLifecycleTransitionError(tenant.status, 'active');
    if (tenant.app_domain === target) {
      throw new ManualSubscriptionRefusedError('ALREADY_ON_DOMAIN', `This tenant is already on ${target}.`);
    }

    const lifecycle = db.platformTenantLifecycle();
    const updated = await lifecycle.changeStatus(tenantId, ['active'], { app_domain: target });
    if (!updated) throw new InvalidTenantLifecycleTransitionError(tenant.status, 'active');

    const tenantDb = lifecycle.withContext(workerContext({ tenantId }));
    await recordAuditEntry(tenantDb, {
      entityType: 'tenants',
      entityId: tenantId,
      action: 'move_domain',
      source: 'api',
      beforeState: { app_domain: tenant.app_domain ?? null },
      afterState: { app_domain: target },
      reason: why.slice(0, 255),
      requestId,
      ipAddress: ip,
      userAgent,
    });

    const after = { ...tenant, app_domain: target };
    const emails = await queueLifecycleEmails({
      platformDb: db,
      tenantDb,
      tenant: after,
      kindKey: `moved:${target}`,
      eventType: 'tenant.domain_moved',
      payload: {},
    });
    return { tenantId: String(tenantId), appDomain: target, loginUrl: tenantBaseUrlFor(after), emails };
  });
  await enqueueDelivery(tenantId, result.emails.propertyIds);
  const { propertyIds, ...emails } = result.emails;
  return { ...result, emails };
}

async function recordPayment({ context, tenantId, input, ip, userAgent, requestId }) {
  const now = new Date();
  const today = utcToday(now);
  const result = await scopedDb().for(context).transaction(async (db) => {
    const tenant = await lockTenant(db, tenantId);
    if (tenant.status !== 'active') throw new InvalidTenantLifecycleTransitionError(tenant.status, 'active');
    const existing = await db.platform().table('subscriptions').where({ tenant_id: tenantId }).forUpdate().first();
    if (!existing || existing.payment_method_provider !== 'manual') {
      throw new ManualSubscriptionRefusedError('NOT_A_MANUAL_SUBSCRIPTION', 'Only a manually-paid subscription can have a payment recorded here. Use Mark subscribed first, or the tenant pays by card.');
    }
    const planCode = typeof input?.plan_code === 'string' ? input.plan_code.trim() : '';
    const plan = planCode ? await db.reference().table('plans').where({ code: planCode, is_active: true }).first() : null;
    const valid = validateManualPayment(input, { plan, today });

    const currentEnd = String(existing.current_period_end instanceof Date ? existing.current_period_end.toISOString().slice(0, 10) : existing.current_period_end).slice(0, 10);
    if (valid.paidUntil <= currentEnd) throw bad('paid_until', 'not_extending', `"paid_until" must be after the current paid-until date (${currentEnd}).`);
    const periodStart = currentEnd > today ? currentEnd : today;

    await db.platform().table('subscriptions').where({ id: existing.id }).update({ plan_id: plan.id, status: 'active', current_period_start: periodStart, current_period_end: valid.paidUntil, consecutive_failed_attempts: 0 });
    const paymentId = await writePaymentRows(db, { tenantId, subscriptionId: existing.id, plan, valid, periodStart, kind: 'renewal', platformUserId: context.platformUserId, now });
    await db.platformTenantLifecycle().changeStatus(tenantId, ['active'], { plan_id: plan.id });

    const tenantDb = db.platformTenantLifecycle().withContext(workerContext({ tenantId }));
    await recordAuditEntry(tenantDb, {
      entityType: 'subscriptions',
      entityId: existing.id,
      action: 'manual_payment_recorded',
      source: 'api',
      beforeState: { paid_until: currentEnd },
      afterState: { plan: plan.code, method: valid.method, reference: valid.reference, amount: valid.amount, currency: valid.currency, paid_until: valid.paidUntil, subscription_payment_id: String(paymentId) },
      reason: valid.reason,
      requestId,
      ipAddress: ip,
      userAgent,
    });

    const emails = await queueLifecycleEmails({
      platformDb: db,
      tenantDb,
      tenant,
      kindKey: `renewal:${valid.paidUntil}`,
      eventType: 'tenant.payment_recorded',
      payload: paymentSummary(valid, plan),
      superAdminsOnly: true,
    });
    return { tenantId: String(tenantId), paidUntil: valid.paidUntil, emails, subscriptionPaymentId: String(paymentId) };
  });
  await enqueueDelivery(tenantId, result.emails.propertyIds);
  const { propertyIds, ...emails } = result.emails;
  return { ...result, emails };
}

/**
 * Manually-paid subscriptions whose paid-until date is within `withinDays` days or already past. Overdue ones are listed,
 * never acted on: suspending is the operator's own decision.
 */
async function listExpiring({ context, withinDays = DEFAULT_EXPIRING_WINDOW_DAYS, now = new Date() }) {
  const days = Number.isInteger(Number(withinDays)) && Number(withinDays) >= 0 && Number(withinDays) <= 366 ? Number(withinDays) : DEFAULT_EXPIRING_WINDOW_DAYS;
  const today = utcToday(now);
  const cutoff = addDays(today, days);
  return scopedDb().for(context).transaction(async (db) => {
    const subscriptions = await db.platform().table('subscriptions').where({ payment_method_provider: 'manual' }).whereNot({ status: 'canceled' }).where('current_period_end', '<=', cutoff).orderBy('current_period_end');
    if (subscriptions.length === 0) return { withinDays: days, today, items: [] };
    const tenants = await db.platformDirectory().table('tenants').whereIn('id', subscriptions.map((row) => row.tenant_id)).select('id', 'slug', 'name', 'status');
    const byId = new Map(tenants.map((row) => [String(row.id), row]));
    const items = subscriptions
      .map((row) => {
        const tenant = byId.get(String(row.tenant_id));
        if (!tenant || ['purging', 'purged', 'offboarding'].includes(tenant.status)) return null;
        const paidUntil = String(row.current_period_end instanceof Date ? row.current_period_end.toISOString().slice(0, 10) : row.current_period_end).slice(0, 10);
        const daysLeft = Math.round((Date.parse(`${paidUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY);
        return { tenantId: String(tenant.id), slug: tenant.slug, name: tenant.name, tenantStatus: tenant.status, paidUntil, daysLeft, overdue: daysLeft < 0 };
      })
      .filter(Boolean);
    return { withinDays: days, today, items };
  });
}

module.exports = { markSubscribed, recordPayment, moveToNewDomain, listExpiring, validateManualPayment, ManualSubscriptionRefusedError, METHODS };
