'use strict';

/**
 * Route wiring for Accounts Receivable — PLAN.md Phase 4. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()`, same as every other business module.
 *
 * SECURITY.md §5's AR column: `ar.view` (front_desk, cashier, manager,
 * admin, super_admin) — see a company's balance, invoices, payment history,
 * the ageing report, and the over-limit/AR-owing informational state at
 * checkout. `ar.manage` (manager, admin, super_admin only, NOT cashier) —
 * account configuration, credit-limit overrides, invoice generation/void,
 * payment recording/apply/void. Following Night Audit's own precedent:
 * credit and collections decisions are manager-tier, not operational.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function arRouter() {
  const router = Router();

  router.get('/ar/accounts', requirePermission('ar.view'), controller.listAccounts);
  router.post('/ar/accounts', requirePermission('ar.manage'), controller.createAccount);
  router.get('/ar/accounts/:id', requirePermission('ar.view'), controller.getAccount);
  router.patch('/ar/accounts/:id', requirePermission('ar.manage'), controller.updateAccount);

  router.get('/ar/accounts/:id/invoices', requirePermission('ar.view'), controller.listInvoicesForAccount);
  router.post('/ar/accounts/:id/invoices', requirePermission('ar.manage'), controller.generateInvoice);
  router.get('/ar/invoices/:id', requirePermission('ar.view'), controller.getInvoice);
  router.post('/ar/invoices/:id/void', requirePermission('ar.manage'), controller.voidInvoice);

  router.get('/ar/accounts/:id/payments', requirePermission('ar.view'), controller.listPaymentsForAccount);
  router.post('/ar/accounts/:id/payments', requirePermission('ar.manage'), controller.recordPayment);
  router.post('/ar/payments/:id/apply', requirePermission('ar.manage'), controller.applyPayment);
  router.post('/ar/payments/:id/void', requirePermission('ar.manage'), controller.voidPayment);

  // Static path — no `:id` in front of it to collide with.
  router.get('/ar/ageing', requirePermission('ar.view'), controller.getAgeingReport);

  return router;
}

module.exports = { arRouter };
