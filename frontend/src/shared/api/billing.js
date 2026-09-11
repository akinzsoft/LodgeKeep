import { request } from './client.js';

/**
 * Billing endpoint wrappers — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22. Same shape as every other `shared/api/*.js` file: plain exported
 * functions, each a thin wrapper over `request()`, matching the real
 * backend response shapes in `backend/src/modules/billing`.
 *
 * No `Idempotency-Key` on the payment-method mutations, deliberately —
 * both are naturally idempotent on repeat calls (see
 * `backend/src/modules/billing/service.js`'s own header), the same
 * "verification is naturally safe to repeat" reasoning `cashiering.js`'s
 * own `verifyPayment` already established for the identical shape.
 */

export function getOverview() {
  return request('/billing/overview');
}

export function listPlans() {
  return request('/billing/plans');
}

export function listInvoices() {
  return request('/billing/invoices');
}

export function listPaymentsForInvoice(invoiceId) {
  return request(`/billing/invoices/${invoiceId}/payments`);
}

/** @param {{email: string, callbackUrl?: string}} params */
export function startPaymentMethodCheckout({ email, callbackUrl }) {
  return request('/billing/payment-method/start', {
    method: 'POST',
    body: { email, callback_url: callbackUrl },
  });
}

export function completePaymentMethod(reference) {
  return request('/billing/payment-method/complete', {
    method: 'POST',
    body: { reference },
  });
}
