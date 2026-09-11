'use strict';

/**
 * The subscription-billing Paystack adapter — PLAN.md Phase 5,
 * PRODUCT_REQUIREMENTS.md §3.22.
 *
 * ── WHY THIS IS A SEPARATE ADAPTER FROM `cashiering/paystack-adapter.js` ──
 *
 * Confirmed by explorer research before writing any code: no shared gateway
 * ABSTRACTION exists to extend — `cashiering/service.js` calls that
 * concrete module's exported functions directly, with no interface a second
 * adapter implements. Given that, and the structural difference between the
 * two relationships this codebase now has with Paystack — a GUEST paying a
 * HOTEL for a stay (cashiering, one-off, `payments`/`folio_line_items`) vs.
 * PLANMSYS charging a TENANT for its subscription (this file, recurring,
 * `subscription_payments`) — building this as its OWN adapter, not a second
 * caller of the guest-payment one, is the deliberate choice
 * PRODUCT_REQUIREMENTS.md §3.22 itself asks for ("a pluggable billing
 * processor, built as its own module from the start").
 *
 * Uses its own, separate credential pair (`BILLING_PAYSTACK_SECRET_KEY`),
 * decoupled from `PAYSTACK_SECRET_KEY` — a real Paystack account can (and
 * for a genuinely separate merchant relationship, should) use a distinct
 * sub-account or API key pair for platform billing versus guest payments,
 * and coupling the two here would make that impossible to configure later
 * without a code change (`PRODUCT_REQUIREMENTS.md §1.1`'s "configuration,
 * never a code branch" rule).
 *
 * Function shapes deliberately mirror `cashiering/paystack-adapter.js`
 * (`initializeTransaction`/`verifyTransaction`/`verifyWebhookSignature`/
 * `toSubunit`, same error classes) — proven, reviewed patterns, not
 * reinvented for this module. Two functions are genuinely new, for the two
 * things guest payments never needed: `verifyTransaction` here ALSO
 * returns the `authorization` object Paystack's real `/transaction/verify`
 * response carries (`authorization_code`/`last4`/`card_type`/`exp_month`/
 * `exp_year`/`reusable`) — the guest-payment adapter never reads this,
 * since a guest payment is never charged again; a subscription payment
 * method IS reused, by design. `chargeAuthorization` is the new recurring-
 * charge primitive neither guest payments nor `initializeTransaction`
 * needed: `POST /transaction/charge_authorization`, charging a
 * previously-captured `authorization_code` with no checkout page at all —
 * this is what the periodic billing job (`src/jobs/subscription-billing.js`)
 * calls for both the ordinary monthly renewal and every dunning retry.
 */

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

class GatewayNotConfiguredError extends AppError {
  constructor(provider) {
    super('PAYMENT_GATEWAY_NOT_CONFIGURED', `The "${provider}" billing gateway has no credentials configured for this environment.`, 501, { provider });
  }
}

class GatewayRequestError extends AppError {
  constructor(provider, message, details) {
    super('PAYMENT_GATEWAY_ERROR', `The "${provider}" billing gateway returned an error: ${message}`, 502, details);
  }
}

function secretKey() {
  const key = process.env.BILLING_PAYSTACK_SECRET_KEY;
  if (!key) throw new GatewayNotConfiguredError('paystack');
  return key;
}

/** Converts a DECIMAL-as-string money amount (e.g. "150.00") to Paystack's smallest-currency-unit integer (kobo/pesewas/cents) — identical to the guest-payment adapter's own version, duplicated rather than imported since these are two deliberately independent modules (see file header). */
function toSubunit(amountDecimalString) {
  const [whole, fraction = ''] = String(amountDecimalString).split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

async function paystackFetch(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.status) {
    throw new GatewayRequestError('paystack', json?.message ?? `HTTP ${response.status}`, { httpStatus: response.status, body: json });
  }
  return json.data;
}

/**
 * Starts a transaction to capture a reusable card authorization for a small
 * verification amount (`BILLING_CARD_VERIFICATION_AMOUNT`, default "50.00")
 * — never the tenant's real subscription price. The verification charge is
 * refunded once the authorization is captured
 * (`src/modules/billing/service.js`'s `completeAddPaymentMethod`); this
 * function only starts the checkout, mirroring the guest-payment adapter's
 * own `initializeTransaction` shape exactly.
 */
async function initializeTransaction({ email, amount, currency, reference, callbackUrl }) {
  const data = await paystackFetch('/transaction/initialize', {
    method: 'POST',
    body: {
      email,
      amount: toSubunit(amount),
      currency,
      reference,
      callback_url: callbackUrl,
    },
  });
  return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference };
}

/**
 * Unlike the guest-payment adapter's own `verifyTransaction`, this ALSO
 * surfaces the `authorization` object — the reusable charge token this
 * whole module exists to capture. See file header for why.
 */
async function verifyTransaction({ reference }) {
  const data = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  const auth = data.authorization ?? {};
  return {
    status: data.status, // 'success' | 'failed' | 'abandoned' | ...
    reference: data.reference,
    providerPaymentId: String(data.id),
    amountSubunit: data.amount,
    currency: data.currency,
    gatewayResponse: data.gateway_response,
    authorization: {
      authorizationCode: auth.authorization_code ?? null,
      reusable: Boolean(auth.reusable),
      last4: auth.last4 ?? null,
      brand: auth.card_type ?? null,
      expMonth: auth.exp_month ? Number(auth.exp_month) : null,
      expYear: auth.exp_year ? Number(auth.exp_year) : null,
    },
  };
}

/**
 * The recurring-charge primitive — `POST /transaction/charge_authorization`,
 * charging a previously-captured `authorization_code` directly, no checkout
 * page. This is what every ordinary monthly renewal and every dunning
 * retry calls (`src/jobs/subscription-billing.js`).
 */
async function chargeAuthorization({ email, amount, currency, authorizationCode, reference }) {
  const data = await paystackFetch('/transaction/charge_authorization', {
    method: 'POST',
    body: {
      email,
      amount: toSubunit(amount),
      currency,
      authorization_code: authorizationCode,
      reference,
    },
  });
  return {
    status: data.status, // 'success' | 'failed' | ...
    reference: data.reference,
    providerPaymentId: String(data.id),
    gatewayResponse: data.gateway_response,
  };
}

/** A real refund call, identical shape to the guest-payment adapter's own — used only to reverse the small card-verification charge. */
async function refundTransaction({ reference, amount }) {
  const data = await paystackFetch('/refund', {
    method: 'POST',
    body: amount ? { transaction: reference, amount: toSubunit(amount) } : { transaction: reference },
  });
  return { status: data.status, reference: data.transaction_reference ?? reference };
}

/**
 * API.md §7 / ARCHITECTURE.md §7: verified by signature before anything
 * else touches the payload. `rawBody` must be the exact bytes Paystack
 * sent. Identical mechanism to the guest-payment adapter's own, keyed on
 * this module's OWN secret key (a webhook for a billing-account event is
 * signed with the billing account's own secret, not the guest-payment
 * one).
 */
function verifyWebhookSignature({ rawBody, signatureHeader }) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha512', secretKey()).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(String(signatureHeader), 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

module.exports = {
  GatewayNotConfiguredError,
  GatewayRequestError,
  toSubunit,
  initializeTransaction,
  verifyTransaction,
  chargeAuthorization,
  refundTransaction,
  verifyWebhookSignature,
};
