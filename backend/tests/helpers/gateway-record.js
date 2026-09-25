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

module.exports = { gatewayRecordFor };
