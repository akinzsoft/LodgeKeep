'use strict';

/**
 * The Paystack gateway adapter — PLAN.md Phase 2.5 step 2 ("Payment
 * integration ... one gateway (Paystack) end to end"), ARCHITECTURE.md §7.
 *
 * ── GAP CLOSURE: EVERY TENANT'S GUEST CARD REVENUE NO LONGER SETTLES INTO
 * ONE SHARED PLATFORM ACCOUNT ─────────────────────────────────────────────
 *
 * Until this pass, every function here read one process-wide
 * `PAYSTACK_SECRET_KEY` — every tenant's guest card payment settled into
 * the SAME Paystack merchant account (ours), which is not viable (a
 * hotel's own room revenue must reach the hotel). Two approaches were
 * researched and compared (per-tenant API keys vs. Paystack Subaccounts/
 * split payments under our own merchant account); Subaccounts was the
 * confirmed choice — lower onboarding friction for the hotel (a bank
 * account, not a whole separate Paystack merchant relationship), a
 * materially smaller change to this module, and it is the only one of the
 * two that lets the platform take a fee at all.
 *
 * This file is now a plain factory, `buildAdapter(secretKey)` — every
 * function it returns is bound to WHATEVER secret key its caller resolved,
 * never a module-level env read. `resolveAdapterForCurrency({db, currency})`
 * is the one real caller of that factory in normal operation: it looks up
 * `platform_payment_integrations` (GLOBAL_REFERENCE, one row per
 * settlement currency — see that migration's own header for why a
 * Paystack merchant integration can never carry more than one currency)
 * by the currency actually in play (a property's own `base_currency` for
 * a fresh charge, or the ALREADY-CHARGED `payments.currency` for a
 * refund/verify — never re-derived from a property's CURRENT config,
 * which can change), decrypts its stored secret
 * (`src/shared/encryption.js`), and hands back a bound adapter. Today
 * exactly one row exists (NGN); a second country/currency is a DATA
 * change to that table, never a code change here.
 *
 * `initializeTransaction` accepts an OPTIONAL `subaccount` (Paystack's
 * own Subaccount code) — when supplied, Paystack auto-splits the charge at
 * settlement between the subaccount (the hotel's own bank account) and
 * this integration's own balance (the platform's cut, `percentage_charge`
 * on the subaccount — 0% for every property today, per this pass's own
 * confirmed scope). A `refundTransaction` call takes no subaccount
 * parameter at all — Paystack's refund API doesn't accept one — and
 * `src/modules/cashiering/service.js`'s `refundPayment` records a real
 * audit-trail entry when refunding a subaccount-split payment, because
 * this was confirmed LIVE against the real sandbox, not assumed: a refund
 * debits the FULL original amount from the platform's OWN balance
 * immediately, with nothing automatically clawed back from the
 * subaccount's own share.
 *
 * `createSubaccount`/`resolveBankAccount` are the two new primitives the
 * Setup screen needs ("bank account number + bank name, which creates the
 * Paystack subaccount via our integration — no hotel-side Paystack account
 * needed"). Both are real calls against `https://api.paystack.co`,
 * confirmed live against the sandbox before this shipped (see PR
 * description / commit history for the exact request/response pairs).
 *
 * `verifyWebhookSignature` is the real HMAC-SHA512 check Paystack's own
 * docs specify (`x-paystack-signature` = HMAC-SHA512 of the raw request
 * body, keyed on the secret key). There is no live public webhook URL in
 * this development environment, so `verifyPayment` (a direct call to
 * `verifyTransaction`) is the primary way a payment's real status is
 * pulled into this system during manual/local verification; the webhook
 * receiver is still real and wired (`POST /webhooks/paystack`, API.md §7)
 * for when this runs behind a real public URL. Multi-currency webhook
 * verification resolves WHICH secret to check against from the (as yet
 * unverified) payload's own `reference`, looked up against the real
 * `payments` row it names — the exact same "look up by reference before
 * trusting anything else" pattern `service.js`'s `handlePaystackWebhook`
 * already used to resolve which TENANT a webhook belongs to, extended
 * here to also resolve which SECRET to verify it with. The signature is
 * still fully verified before anything is acted on — this only changes
 * which key it's verified against, never whether it's verified.
 *
 * `PAYMENT_GATEWAY_NOT_CONFIGURED` (`GatewayNotConfiguredError`) is thrown
 * — never a silent fallback to the old shared-key behaviour — whenever no
 * active `platform_payment_integrations` row exists for a currency. This
 * is deliberate: falling back to a shared key would silently reintroduce
 * the exact defect this pass exists to close.
 */

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');
const { decrypt } = require('../../shared/encryption');

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

/**
 * A property has no configured payout destination at all — distinct from
 * `GatewayNotConfiguredError` (no credentials exist for this ENVIRONMENT),
 * this means the ENVIRONMENT is fine but this specific hotel has never
 * completed Setup's "bank account" step. A 422, not a 501: this is an
 * ordinary, expected, actionable state for a real property, not an
 * environment misconfiguration.
 */
class PropertyPayoutNotConfiguredError extends AppError {
  constructor(propertyId) {
    super(
      'PAYMENT_SUBACCOUNT_NOT_CONFIGURED',
      'This property has not configured a payout bank account yet — card payments are unavailable until Setup > Payments is completed.',
      422,
      { propertyId }
    );
  }
}

/** Upper bound for a Paystack READ call (Verify Transaction), in ms — default 8s; verify normally answers in about 1s. */
function readTimeoutMs() {
  const configured = Number(process.env.PAYSTACK_READ_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 8000;
}

/** Converts a DECIMAL-as-string money amount (e.g. "150.00") to Paystack's smallest-currency-unit integer (kobo/pesewas/cents). */
function toSubunit(amountDecimalString) {
  const [whole, fraction = ''] = String(amountDecimalString).split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

/**
 * Every real Paystack HTTP call this module makes, bound to ONE resolved
 * secret key. Never call this directly with a raw env var outside
 * `resolveAdapterForCurrency` (or a test) — see file header.
 */
function buildAdapter(secretKey) {
  if (!secretKey) throw new GatewayNotConfiguredError('paystack');

  async function paystackFetch(path, { method = 'GET', body, timeoutMs } = {}) {
    // Only a call that passes `timeoutMs` (Verify Transaction) is bounded, so a
    // hung Paystack call cannot hold a webhook request open. Other reads (e.g.
    // bank resolution) and all writes (initialize, refund, subaccount) are
    // deliberately NOT timed out: aborting a POST whose outcome is unknown would
    // be worse than waiting for it, and bank resolution can be legitimately slow.
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    let response;
    try {
      response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new GatewayRequestError('paystack', timedOut ? 'the request timed out' : (error?.message ?? 'network error'), timedOut ? { timedOut: true } : { network: true });
    }

    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.status) {
      throw new GatewayRequestError('paystack', json?.message ?? `HTTP ${response.status}`, { httpStatus: response.status, body: json });
    }
    return json.data;
  }

  /**
   * Starts a transaction — the guest/staff-facing `authorization_url` is
   * what the front desk shows (as a link or QR code,
   * PRODUCT_REQUIREMENTS.md §3.5) for the guest to complete on their own
   * device. `channels` (optional, e.g. `['qr']`) narrows the checkout to
   * those payment methods; omitted, Paystack offers every channel the
   * account supports. `subaccount` (optional) is the property's own
   * Paystack Subaccount code — when supplied, Paystack auto-splits this
   * charge at settlement per that subaccount's own `percentage_charge`.
   */
  async function initializeTransaction({ email, amount, currency, reference, callbackUrl, channels, subaccount }) {
    const data = await paystackFetch('/transaction/initialize', {
      method: 'POST',
      body: {
        email,
        amount: toSubunit(amount),
        currency,
        reference,
        callback_url: callbackUrl,
        ...(channels ? { channels } : {}),
        ...(subaccount ? { subaccount } : {}),
      },
    });
    return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference };
  }

  /** The manual/fallback sync path (see file header) — also what the webhook handler calls to double-check before trusting the payload. */
  async function verifyTransaction({ reference }) {
    const data = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`, { timeoutMs: readTimeoutMs() });
    return {
      status: data.status, // 'success' | 'failed' | 'abandoned' | ...
      reference: data.reference,
      providerPaymentId: String(data.id),
      amountSubunit: data.amount,
      // What was ORIGINALLY requested — Paystack's `amount` is what was
      // collected, which can exceed this when the customer bore a fee
      // (`src/shared/gateway-record.js` accepts that, and nothing less).
      requestedAmountSubunit: data.requested_amount ?? null,
      currency: data.currency,
      gatewayResponse: data.gateway_response,
      channel: data.channel ?? null, // 'card' | 'ussd' | 'bank_transfer' | 'qr' | ...,
    };
  }

  /**
   * A real refund call — full or partial (Paystack accepts an optional
   * `amount`; omitted means a full refund). No `subaccount` parameter
   * exists on Paystack's refund API at all — confirmed live against the
   * sandbox: a refund always debits the FULL original amount from THIS
   * integration's own balance, regardless of how the original charge was
   * split. `service.js`'s `refundPayment` is what records the resulting
   * shortfall against the property when the original payment used a
   * subaccount.
   */
  async function refundTransaction({ reference, amount }) {
    const data = await paystackFetch('/refund', {
      method: 'POST',
      body: amount ? { transaction: reference, amount: toSubunit(amount) } : { transaction: reference },
    });
    return { status: data.status, reference: data.transaction_reference ?? reference };
  }

  /**
   * `POST /subaccount` — creates the hotel's own Paystack Subaccount.
   * Confirmed live against the sandbox: Paystack performs its own real
   * bank-account resolution as part of this call and returns the
   * resolved `account_name` directly, so a caller does not need a
   * separate `resolveBankAccount` round trip just to learn the name a
   * newly-created subaccount resolved to (only the PRE-creation
   * confirmation step — "is this the right account?" — needs that).
   */
  async function createSubaccount({ businessName, bankCode, accountNumber, percentageCharge }) {
    const data = await paystackFetch('/subaccount', {
      method: 'POST',
      body: {
        business_name: businessName,
        settlement_bank: bankCode,
        account_number: accountNumber,
        percentage_charge: percentageCharge,
      },
    });
    return {
      subaccountCode: data.subaccount_code,
      accountName: data.account_name,
      bankName: data.settlement_bank,
    };
  }

  /**
   * `GET /bank/resolve` — a real, standalone bank-account-name lookup, for
   * the Setup screen's own "confirm this is the right account before we
   * create anything" step (DESIGN_SYSTEM.md §2's confirm-before-a-real-
   * effect rule). Note confirmed live: Paystack's own sandbox limits this
   * specific endpoint to 3 real (non-test-bank-code) resolves per day —
   * `createSubaccount` above performs its own internal resolution and is
   * NOT subject to that same limit, so this call is used once, for
   * confirmation, never repeated per subaccount creation attempt.
   */
  async function resolveBankAccount({ bankCode, accountNumber }) {
    const data = await paystackFetch(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    return { accountName: data.account_name };
  }

  /**
   * API.md §7 / ARCHITECTURE.md §7: "verified by signature before anything
   * else touches the payload." `rawBody` must be the exact bytes Paystack
   * sent (before JSON parsing) — HMAC is over the raw body, not a
   * re-serialized object, which can differ in whitespace/key order.
   */
  function verifyWebhookSignature({ rawBody, signatureHeader }) {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(String(signatureHeader), 'utf8');
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  return {
    initializeTransaction,
    verifyTransaction,
    refundTransaction,
    createSubaccount,
    resolveBankAccount,
    verifyWebhookSignature,
  };
}

/**
 * Resolves the real, decrypted Paystack integration for a given ISO 4217
 * currency — the one place `platform_payment_integrations` is ever read.
 * `db` must be a scoped accessor (reaches the GLOBAL_REFERENCE table
 * through the ordinary `table()` path, no special context needed).
 * Throws `GatewayNotConfiguredError` for a currency with no active row —
 * the same "flagged stub, not invented behaviour" shape this file always
 * used for a missing env var, now for a missing catalogue row instead.
 */
async function resolveAdapterForCurrency(db, currency) {
  const integration = await db.table('platform_payment_integrations').where({ currency, is_active: true }).first();
  if (!integration) throw new GatewayNotConfiguredError('paystack');
  return { integration, adapter: buildAdapter(decrypt(integration.secret_key_encrypted)) };
}

module.exports = {
  GatewayNotConfiguredError,
  GatewayRequestError,
  PropertyPayoutNotConfiguredError,
  toSubunit,
  buildAdapter,
  resolveAdapterForCurrency,
};
