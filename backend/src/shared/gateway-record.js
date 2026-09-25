'use strict';

/**
 * Compares Paystack's OWN record of a transaction (the normalised result of
 * `GET /transaction/verify/:reference`) against the LOCAL payment intent it is
 * supposed to settle — ARCHITECTURE.md §7: a provider callback is a hint, the
 * provider's record is the truth.
 *
 * A webhook's HMAC proves who SENT it, not that what it CLAIMS is what
 * Paystack actually holds. Everything a webhook or a browser callback asserts
 * (status, amount, currency) is therefore re-derived from this record, and
 * money is only ever recorded when the record agrees with the local row.
 *
 * Pure: no database, no adapter import. Callers pass an already-normalised
 * record so the check is identical for the guest-payment and billing
 * gateways, and is unaffected by tests that `jest.mock` an adapter module.
 * Amounts are compared as exact integers via `toCents` (never floats,
 * ARCHITECTURE.md §1) rather than the adapters' own `toSubunit`, which is
 * absent whenever an adapter module is mocked.
 *
 * FAILS CLOSED: a `success` record with no usable amount is a mismatch, never
 * a pass.
 */

const { toCents } = require('./money');

/** Paystack statuses that mean the transaction is over and did NOT succeed. */
const FAILED_STATUSES = new Set(['failed', 'reversed']);
/** Paystack statuses that mean the transaction is still (or may yet be) in flight. */
const SUCCESS_STATUS = 'success';

/**
 * @param {object} args
 * @param {object} args.record  normalised Verify Transaction result: `{status, reference, amountSubunit, requestedAmountSubunit?, currency}`
 * @param {object} args.local   `{reference, amount (a DECIMAL string), currency}` taken from the LOCAL payment row
 * @returns {{verdict: 'confirmed'|'failed'|'not_final'|'mismatch', reasons: object[], expected: object, observed: object}}
 */
function classifyGatewayRecord({ record, local }) {
  const expectedCents = toCents(local.amount);
  const expected = {
    reference: local.reference,
    amountSubunit: expectedCents.toString(),
    currency: String(local.currency).toUpperCase(),
  };
  const observed = {
    status: record?.status ?? null,
    reference: record?.reference ?? null,
    amountSubunit: record?.amountSubunit ?? null,
    requestedAmountSubunit: record?.requestedAmountSubunit ?? null,
    currency: record?.currency ?? null,
  };

  const reasons = [];

  // A record that names a DIFFERENT reference than the one we asked about is
  // never the transaction we mean, whatever its status.
  if (observed.reference != null && String(observed.reference) !== String(local.reference)) {
    reasons.push({
      code: 'REFERENCE_MISMATCH',
      message: 'Paystack returned a record for a different transaction reference.',
      details: { expected: local.reference, observed: observed.reference },
    });
  }

  const status = String(observed.status ?? '').toLowerCase();

  if (status === SUCCESS_STATUS) {
    if (observed.currency == null || String(observed.currency).toUpperCase() !== expected.currency) {
      reasons.push({
        code: 'CURRENCY_MISMATCH',
        message: 'Paystack recorded the payment in a different currency than the local payment expects.',
        details: { expected: expected.currency, observed: observed.currency },
      });
    }

    const paid = toSafeInteger(observed.amountSubunit);
    if (paid == null) {
      reasons.push({
        code: 'AMOUNT_MISSING',
        message: 'Paystack returned no usable amount for a successful transaction.',
        details: { observed: observed.amountSubunit },
      });
    } else {
      // Paystack's `amount` is what was collected. If the customer bore the
      // processing fee it can exceed what was requested, in which case the
      // REQUESTED amount is what must match. It is never acceptable for
      // Paystack to have collected LESS than the local payment expects.
      const requested = toSafeInteger(observed.requestedAmountSubunit);
      const paidBig = BigInt(paid);
      const exact = paidBig === expectedCents;
      const feeBorne = requested != null && BigInt(requested) === expectedCents && paidBig >= expectedCents;
      if (!exact && !feeBorne) {
        reasons.push({
          code: 'AMOUNT_MISMATCH',
          message: 'Paystack collected a different amount than the local payment expects.',
          details: { expected: expected.amountSubunit, observed: paid, requested },
        });
      }
    }

    return { verdict: reasons.length === 0 ? 'confirmed' : 'mismatch', reasons, expected, observed };
  }

  if (FAILED_STATUSES.has(status)) {
    // A failed transaction moved no money, so its amount is irrelevant — only
    // a wrong-reference record can make it a mismatch.
    return { verdict: reasons.length === 0 ? 'failed' : 'mismatch', reasons, expected, observed };
  }

  // abandoned / ongoing / pending / processing / queued / anything unknown:
  // still (or possibly still) in flight. Never capture and never terminally
  // fail on it.
  return { verdict: reasons.length === 0 ? 'not_final' : 'mismatch', reasons, expected, observed };
}

function toSafeInteger(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Decides whether a failure to obtain Paystack's record means "Paystack has no
 * such transaction" (a definitive answer — reject) or "we could not get an
 * answer" (leave the event for a retry).
 *
 * Duck-typed on `code`/`details` rather than `instanceof`, because the adapter
 * modules are `jest.mock`ed in several suites.
 *
 * - 404 from Paystack: no such transaction -> `'record_not_found'`.
 * - Everything else (401/403 = misconfigured key, 429, 5xx, timeout, network
 *   failure, an unconfigured gateway, or any unexpected error) -> `'transient'`.
 *   A bad key must be retryable and LOUD, never a silent rejection of a
 *   genuine payment.
 */
function interpretGatewayError(error) {
  const httpStatus = error?.details?.httpStatus;
  if (httpStatus === 404) return 'record_not_found';
  return 'transient';
}

module.exports = { classifyGatewayRecord, interpretGatewayError };
