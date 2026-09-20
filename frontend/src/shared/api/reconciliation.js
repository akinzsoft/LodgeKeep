import { request, requestBlob } from './client.js';

/**
 * The payment reconciliation report — gap closure: guest card payments now
 * settle into each property's own Paystack Subaccount, and a hotel needs
 * one view of every payment it has taken (room folio, bar/restaurant tab,
 * guest QR order, guest-portal booking) to tick against its Paystack
 * settlement/bank statement. Same shape as `reporting.js`: plain exported
 * functions, each a thin wrapper over `request()`/`requestBlob()`.
 */

export function getPaymentReconciliation({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  return request(`/reconciliation/payments?${params}`);
}

/** Same filters as the on-screen query — PRODUCT_REQUIREMENTS.md §3.11's "exports must reflect the applied filters." */
export function getPaymentReconciliationCsv({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, format: 'csv' });
  return requestBlob(`/reconciliation/payments?${params}`);
}
