'use strict';

/**
 * Route wiring for the cashiering module — PLAN.md Phase 2.5. Mounted
 * under `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()`, same as every other business module — EXCEPT
 * `paystackWebhookRouter()`, which is mounted separately, BEFORE
 * `authenticate('staff')` (API.md §7: a webhook authenticates by signature,
 * never a bearer token).
 *
 * SECURITY.md §5's matrix row for Cashiering, "Limited" defined per that
 * section's own example: front_desk gets `cashiering.post_charge` only
 * (view a folio, post a charge) — everything money-handling (payments,
 * refunds, voids, split billing) requires `cashiering.void_line`. Cashier/
 * manager/admin/super_admin hold both; housekeeping/pos_operator hold
 * neither.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function cashieringRouter() {
  const router = Router();

  router.get('/cashiering/reservations/:reservationId/folios', requirePermission('cashiering.post_charge'), controller.listFoliosForReservation);
  router.post('/cashiering/reservations/:reservationId/folios', requirePermission('cashiering.void_line'), controller.openAdditionalFolio);

  router.get('/cashiering/folios/:folioId', requirePermission('cashiering.post_charge'), controller.getFolio);
  router.post('/cashiering/folios/:folioId/charges', requirePermission('cashiering.post_charge'), controller.postCharge);
  router.post('/cashiering/folios/:folioId/adjustments', requirePermission('cashiering.void_line'), controller.postAdjustment);
  router.post('/cashiering/folios/:folioId/payments/cash', requirePermission('cashiering.void_line'), controller.captureCashPayment);
  router.post('/cashiering/folios/:folioId/payments/paystack', requirePermission('cashiering.void_line'), controller.capturePaystackPayment);

  router.post('/cashiering/line-items/:lineItemId/void', requirePermission('cashiering.void_line'), controller.voidLineItem);
  router.post('/cashiering/line-items/:lineItemId/move', requirePermission('cashiering.void_line'), controller.moveLineItem);

  router.post('/cashiering/payments/:id/start-checkout', requirePermission('cashiering.void_line'), controller.startCheckout);
  router.post('/cashiering/payments/:id/verify', requirePermission('cashiering.void_line'), controller.verifyPayment);
  router.post('/cashiering/payments/:id/refund', requirePermission('cashiering.void_line'), controller.refundPayment);

  return router;
}

/** Public — mounted BEFORE `authenticate('staff')` (see file header and API.md §7). */
function paystackWebhookRouter() {
  const router = Router();
  router.post('/webhooks/paystack', controller.receivePaystackWebhook);
  return router;
}

module.exports = { cashieringRouter, paystackWebhookRouter };
