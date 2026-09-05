'use strict';

/**
 * The Paystack gateway adapter — PLAN.md Phase 2.5 step 2 ("Payment
 * integration ... one gateway (Paystack) end to end"), ARCHITECTURE.md §7.
 *
 * A REAL sandbox integration, using test credentials the user supplied for
 * this session (`PAYSTACK_SECRET_KEY`/`PAYSTACK_PUBLIC_KEY` in `.env`) —
 * not a stub. This is the ONLY file in the cashiering module that calls
 * `fetch`, mirroring `src/shared/api/client.js`'s frontend rule ("the one
 * place... that calls fetch") applied to an outbound gateway call instead
 * of the browser: every other file in this module reaches Paystack only
 * through the functions exported here.
 *
 * ── WHAT THIS DOES AND DOES NOT COVER ────────────────────────────────────
 *
 * `initializeTransaction`/`verifyTransaction`/`refundTransaction` are real
 * calls against `https://api.paystack.co`. `verifyWebhookSignature` is the
 * real HMAC-SHA512 check Paystack's own docs specify
 * (`x-paystack-signature` = HMAC-SHA512 of the raw request body, keyed on
 * the secret key). There is no live public webhook URL in this development
 * environment (no tunnel/ingress is configured), so
 * `src/modules/cashiering/service.js`'s `verifyPayment` — a direct call to
 * `verifyTransaction` — is the primary way a payment's real status is
 * pulled into this system during manual/local verification; the webhook
 * receiver is still real and wired (`POST /webhooks/paystack`, API.md §7)
 * for when this runs behind a real public URL.
 *
 * `PAYMENT_GATEWAY_NOT_CONFIGURED` (`GatewayNotConfiguredError`) is thrown
 * rather than a silent no-op if `PAYSTACK_SECRET_KEY` is absent — the same
 * "flagged stub, not invented behaviour" discipline `src/modules/
 * notifications/email-adapter.js`'s `console` fallback and MFA
 * verification's `501` both already established, applied here to a missing
 * credential rather than an unbuilt feature.
 */

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

class GatewayNotConfiguredError extends AppError {
  constructor(provider) {
    super('PAYMENT_GATEWAY_NOT_CONFIGURED', `The "${provider}" payment gateway has no credentials configured for this environment.`, 501, { provider });
  }
}

class GatewayRequestError extends AppError {
  constructor(provider, message, details) {
    super('PAYMENT_GATEWAY_ERROR', `The "${provider}" gateway returned an error: ${message}`, 502, details);
  }
}

function secretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new GatewayNotConfiguredError('paystack');
  return key;
}

/** Converts a DECIMAL-as-string money amount (e.g. "150.00") to Paystack's smallest-currency-unit integer (kobo/pesewas/cents). */
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
 * Starts a transaction — the guest/staff-facing `authorization_url` is what
 * the front desk shows (as a link or QR code, PRODUCT_REQUIREMENTS.md §3.5)
 * for the guest to complete on their own device.
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

/** The manual/fallback sync path (see file header) — also what the webhook handler calls to double-check before trusting the payload. */
async function verifyTransaction({ reference }) {
  const data = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  return {
    status: data.status, // 'success' | 'failed' | 'abandoned' | ...
    reference: data.reference,
    providerPaymentId: String(data.id),
    amountSubunit: data.amount,
    currency: data.currency,
    gatewayResponse: data.gateway_response,
  };
}

/** A real refund call — full or partial (Paystack accepts an optional `amount`; omitted means a full refund). */
async function refundTransaction({ reference, amount }) {
  const data = await paystackFetch('/refund', {
    method: 'POST',
    body: amount ? { transaction: reference, amount: toSubunit(amount) } : { transaction: reference },
  });
  return { status: data.status, reference: data.transaction_reference ?? reference };
}

/**
 * API.md §7 / ARCHITECTURE.md §7: "verified by signature before anything
 * else touches the payload." `rawBody` must be the exact bytes Paystack
 * sent (before JSON parsing) — HMAC is over the raw body, not a
 * re-serialized object, which can differ in whitespace/key order.
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
  refundTransaction,
  verifyWebhookSignature,
};
