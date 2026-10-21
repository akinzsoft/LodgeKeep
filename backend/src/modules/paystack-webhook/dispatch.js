'use strict';

/**
 * ONE Paystack webhook endpoint for both integrations.
 *
 * Paystack allows a single live webhook URL per account. The guest/POS
 * payments (key in `platform_payment_integrations`) and subscription billing
 * (`BILLING_PAYSTACK_SECRET_KEY`) can share one account, so one route must
 * serve both. This module only DECIDES which existing handler owns an event;
 * the handlers themselves are untouched, so their signature check, dedup
 * (`persistWebhookEvent`), Verify-Transaction-against-Paystack step and
 * idempotent apply all stay exactly as they were. An event goes to exactly
 * one handler, so it can never be applied by both.
 *
 * Routing (`routeFor`): a reference the billing code mints (`billing-card-*`,
 * `billing-charge-*`) is a billing event. Any other reference belongs to the
 * route's default owner: the guest handler on `/webhooks/paystack`; on the
 * legacy alias `/webhooks/billing-paystack` it is billing unless a local
 * guest `payments` row carries that reference. Refund events name the
 * transaction in `data.transaction_reference`, so that is read too.
 *
 * Signature: each handler verifies with its own key (the guest key chosen by
 * the payment's currency, the billing env key), so two different keys work.
 * If the handler could not verify the event (unknown reference, or a bad
 * signature) the dispatcher checks it against EVERY candidate key. A genuine
 * event we simply have no record of (a payment made on the same Paystack
 * account outside this app) is answered 200 and logged by type and reference
 * only; an event no key verifies is answered 401. The handler has already
 * kept the raw event as unverified evidence by then.
 */

const { scopedDb, knex } = require('../../db');
const { systemContext } = require('../tenancy');
const cashieringService = require('../cashiering/service');
const paystackAdapter = require('../cashiering/paystack-adapter');
const billingService = require('../billing/service');
const billingGateway = require('../billing/paystack-gateway');

const BILLING_REFERENCE_PREFIX = 'billing-';

function referenceOf(payload) {
  const data = payload?.data;
  const reference = data?.reference ?? data?.transaction_reference;
  return typeof reference === 'string' && reference ? reference : null;
}

async function guestPaymentExists(reference) {
  // Cross-tenant lookup before any tenant is known: raw knex, as `handlePaystackWebhook` itself does.
  const row = await knex()('payments').where({ provider: 'paystack', provider_reference: reference }).first();
  return Boolean(row);
}

/** @returns {Promise<'billing'|'guest'>} */
async function routeFor({ reference, defaultOwner }) {
  if (reference && reference.startsWith(BILLING_REFERENCE_PREFIX)) return 'billing';
  if (defaultOwner === 'guest') return 'guest';
  return reference && (await guestPaymentExists(reference)) ? 'guest' : 'billing';
}

/** True when ANY configured Paystack key (billing env key, or an active guest integration key) signs this body. */
async function anyKeyVerifies({ rawBody, signatureHeader }) {
  if (!signatureHeader) return false;
  try {
    if (billingGateway.verifyWebhookSignature({ rawBody, signatureHeader })) return true;
  } catch {
    // Billing key not configured — not a candidate.
  }
  const db = scopedDb().for(systemContext());
  const integrations = await db.table('platform_payment_integrations').where({ is_active: true });
  for (const { currency } of integrations) {
    try {
      const { adapter } = await paystackAdapter.resolveAdapterForCurrency(db, currency);
      if (adapter.verifyWebhookSignature({ rawBody, signatureHeader })) return true;
    } catch {
      // This integration cannot be decrypted/built — not a candidate.
    }
  }
  return false;
}

/**
 * @returns {Promise<{status: 200|401, owner: 'billing'|'guest', handled: boolean}>}
 * `handled` is true when the owning handler verified the event.
 */
async function dispatchPaystackWebhook({ rawBody, signatureHeader, payload, defaultOwner }) {
  const reference = referenceOf(payload);
  const owner = await routeFor({ reference, defaultOwner });

  const result =
    owner === 'billing'
      ? await billingService.receiveBillingWebhook({ rawBody, signatureHeader, payload })
      : await cashieringService.handlePaystackWebhook({ rawBody, signatureHeader, parsedBody: payload });

  if (result?.verified) return { status: 200, owner, handled: true };

  if (await anyKeyVerifies({ rawBody, signatureHeader })) {
    // Signed by us but concerning nothing we hold: acknowledge so Paystack stops retrying.
    console.info(`[paystack-webhook] unmatched event ignored: event=${payload?.event ?? 'unknown'} reference=${reference ?? 'none'}`);
    return { status: 200, owner, handled: false };
  }
  return { status: 401, owner, handled: false };
}

module.exports = { dispatchPaystackWebhook, routeFor, referenceOf, BILLING_REFERENCE_PREFIX };
