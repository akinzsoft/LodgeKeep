'use strict';

const { toCents } = require('../../src/shared/money');

/**
 * A `verifyTransaction` result for a stored payment row that AGREES with it —
 * status success, the row's own reference, the row's amount in subunits and
 * the row's currency. Built from the stored row so a mock can never drift from
 * the fixture it is standing in for; pass `overrides` to make it disagree.
 */
function gatewayRecordFor(paymentRow, overrides = {}) {
  return {
    status: 'success',
    reference: paymentRow.provider_reference,
    providerPaymentId: '900001',
    amountSubunit: Number(toCents(paymentRow.amount)),
    currency: paymentRow.currency,
    gatewayResponse: 'Successful',
    channel: 'card',
    ...overrides,
  };
}

/**
 * A `verifyTransaction` mock implementation that answers, for whatever
 * reference it is asked about, with a record built from the STORED payment row
 * of that reference (see `gatewayRecordFor`). For suites where the payment is
 * created deep inside a flow and its reference is generated, so the test cannot
 * hard-code it. `getTrx` is a function so it reads the harness's CURRENT
 * transaction: `recordForStoredPayment(() => t.trx, { status: 'success' })`.
 */
function recordForStoredPayment(getTrx, overrides = {}) {
  return async ({ reference }) => {
    const row = await getTrx()('payments').where({ provider_reference: reference }).first();
    if (!row) throw new Error(`recordForStoredPayment: no stored payment has reference ${reference}`);
    return gatewayRecordFor(row, overrides);
  };
}

module.exports = { gatewayRecordFor, recordForStoredPayment };
