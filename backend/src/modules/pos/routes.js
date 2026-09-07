'use strict';

/**
 * Route wiring for the POS module — PLAN.md Phase 4. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()`, same as every other business module.
 *
 * SECURITY.md §5's matrix showed a plain "✓" for `pos_operator`; this
 * session's confirmed decision splits it the same way Cashiering's own
 * "Limited" cell already is — `pos.operate` (run the register) for
 * pos_operator/manager/admin/super_admin, `pos.manage` (outlet/terminal/
 * menu configuration, and the "Manager overrides" PRODUCT_REQUIREMENTS.md
 * §3.4 names explicitly) for manager/admin/super_admin only. SECURITY.md
 * itself records this correction — see that file directly.
 *
 * The menu-item stock-out toggle (`set-availability`) is deliberately
 * `pos.operate`, not `pos.manage` — PRODUCT_REQUIREMENTS.md §3.4 asks for
 * exactly this ("staff mark an item unavailable without an admin edit").
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function posRouter() {
  const router = Router();

  router.get('/pos/outlets', requirePermission('pos.operate'), controller.listOutlets);
  router.post('/pos/outlets', requirePermission('pos.manage'), controller.createOutlet);
  router.patch('/pos/outlets/:id', requirePermission('pos.manage'), controller.updateOutlet);
  router.post('/pos/outlets/:id/archive', requirePermission('pos.manage'), controller.archiveOutlet);

  router.get('/pos/terminals', requirePermission('pos.operate'), controller.listTerminals);
  router.post('/pos/terminals', requirePermission('pos.manage'), controller.createTerminal);
  router.patch('/pos/terminals/:id', requirePermission('pos.manage'), controller.updateTerminal);
  router.post('/pos/terminals/:id/archive', requirePermission('pos.manage'), controller.archiveTerminal);

  router.get('/pos/menu-items', requirePermission('pos.operate'), controller.listMenuItems);
  router.post('/pos/menu-items', requirePermission('pos.manage'), controller.createMenuItem);
  router.patch('/pos/menu-items/:id', requirePermission('pos.manage'), controller.updateMenuItem);
  router.post('/pos/menu-items/:id/set-availability', requirePermission('pos.operate'), controller.setMenuItemAvailability);
  router.post('/pos/menu-items/:id/archive', requirePermission('pos.manage'), controller.archiveMenuItem);

  router.get('/pos/guests/in-house', requirePermission('pos.operate'), controller.findInHouseForCharge);

  router.get('/pos/orders', requirePermission('pos.operate'), controller.listOrders);
  router.get('/pos/orders/:id', requirePermission('pos.operate'), controller.getOrder);
  router.post('/pos/orders', requirePermission('pos.operate'), controller.openOrder);
  router.post('/pos/orders/:id/items', requirePermission('pos.operate'), controller.addItem);
  router.post('/pos/orders/:id/items/:itemId/void', requirePermission('pos.operate'), controller.voidOrderItem);
  router.post('/pos/orders/:id/items/:itemId/split-group', requirePermission('pos.operate'), controller.assignItemSplitGroup);
  router.post('/pos/orders/:id/void', requirePermission('pos.operate'), controller.voidOrder);
  router.post('/pos/orders/:id/settle', requirePermission('pos.operate'), controller.settleOrder);
  router.post('/pos/orders/:id/settlements/:settlementId/void', requirePermission('pos.manage'), controller.voidSettlement);

  router.get('/pos/shifts', requirePermission('pos.operate'), controller.listShifts);
  router.get('/pos/shifts/:id', requirePermission('pos.operate'), controller.getShift);
  router.post('/pos/shifts', requirePermission('pos.operate'), controller.openShift);
  router.post('/pos/shifts/:id/close', requirePermission('pos.operate'), controller.closeShift);

  return router;
}

module.exports = { posRouter };
