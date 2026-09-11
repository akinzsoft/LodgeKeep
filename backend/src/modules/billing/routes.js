'use strict';

/**
 * Route wiring for the billing module — PLAN.md Phase 5. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()`, same as every other business module — EXCEPT
 * `billingWebhookRouter()`, mounted separately, BEFORE `authenticate('staff')`
 * (API.md §7: a webhook authenticates by signature, never a bearer token),
 * matching `cashiering`'s own `paystackWebhookRouter()` exactly.
 *
 * `billing.view` (see the subscription/plan/invoices) vs. `billing.manage`
 * (add or replace the payment method) — admin/super_admin only, both keys.
 * See `20260924095000_seed_billing_permissions.js`'s own header for why
 * this is narrower than every other module's RBAC split.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function billingRouter() {
  const router = Router();

  router.get('/billing/overview', requirePermission('billing.view'), controller.getOverview);
  router.get('/billing/plans', requirePermission('billing.view'), controller.listPlans);
  router.get('/billing/invoices', requirePermission('billing.view'), controller.listInvoices);
  router.get('/billing/invoices/:invoiceId/payments', requirePermission('billing.view'), controller.listPaymentsForInvoice);

  router.post('/billing/payment-method/start', requirePermission('billing.manage'), controller.startAddPaymentMethod);
  router.post('/billing/payment-method/complete', requirePermission('billing.manage'), controller.completeAddPaymentMethod);

  return router;
}

/** Public — mounted BEFORE `authenticate('staff')` (see file header and API.md §7). */
function billingWebhookRouter() {
  const router = Router();
  router.post('/webhooks/billing-paystack', controller.receiveWebhook);
  return router;
}

module.exports = { billingRouter, billingWebhookRouter };
