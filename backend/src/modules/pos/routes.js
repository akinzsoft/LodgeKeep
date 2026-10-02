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
const scope = require('./outlet-scope');
const { receiveImage } = require('../../shared/image-store');
const { requirePermission, requireAnyPermission } = require('../../auth');

function posRouter() {
  const router = Router();

  // Also readable with `pos.stock_view`: a Storekeeper (no Register access)
  // still has to name the outlets stock moves between.
  router.get('/pos/outlets', requireAnyPermission(['pos.operate', 'pos.stock_view']), controller.listOutlets);
  router.post('/pos/outlets', requirePermission('pos.manage'), controller.createOutlet);
  router.patch('/pos/outlets/:id', requirePermission('pos.manage'), controller.updateOutlet);
  router.post('/pos/outlets/:id/archive', requirePermission('pos.manage'), controller.archiveOutlet);
  // Recording which bank accounts an outlet's external terminals pay into is
  // Setup (admin / super_admin: `setup.manage`), not an outlet manager's call.
  router.get('/pos/outlets/:id/terminal-accounts', requirePermission('setup.manage'), controller.listOutletTerminalAccounts);
  router.post('/pos/outlets/:id/terminal-accounts', requirePermission('setup.manage'), controller.createOutletTerminalAccount);
  router.patch('/pos/outlets/:id/terminal-accounts/:accountId', requirePermission('setup.manage'), controller.updateOutletTerminalAccount);
  router.delete('/pos/outlets/:id/terminal-accounts/:accountId', requirePermission('setup.manage'), controller.removeOutletTerminalAccount);
  // What the Register shows an operator: id, name and last 4 only.
  router.get('/pos/outlets/:id/terminal-account-options', requirePermission('pos.operate'), scope.outletParamInScope, controller.listOutletTerminalAccountOptions);
  router.put('/pos/outlets/:id/categories', requirePermission('pos.manage'), controller.setOutletCategories);

  router.get('/pos/terminals', requirePermission('pos.operate'), controller.listTerminals);
  router.post('/pos/terminals', requirePermission('pos.manage'), controller.createTerminal);
  router.patch('/pos/terminals/:id', requirePermission('pos.manage'), controller.updateTerminal);
  router.post('/pos/terminals/:id/archive', requirePermission('pos.manage'), controller.archiveTerminal);

  router.get('/pos/menu-categories', requirePermission('pos.operate'), controller.listMenuCategories);
  router.post('/pos/menu-categories', requirePermission('pos.manage'), controller.createMenuCategory);
  router.patch('/pos/menu-categories/:id', requirePermission('pos.manage'), controller.updateMenuCategory);
  router.post('/pos/menu-categories/:id/archive', requirePermission('pos.manage'), controller.archiveMenuCategory);

  router.get('/pos/menu-items', requirePermission('pos.operate'), controller.listMenuItems);
  router.post('/pos/menu-items', requirePermission('pos.manage'), controller.createMenuItem);
  router.patch('/pos/menu-items/:id', requirePermission('pos.manage'), controller.updateMenuItem);
  router.post('/pos/menu-items/:id/set-availability', requirePermission('pos.operate'), scope.availabilityOutletInScope, controller.setMenuItemAvailability);
  router.put('/pos/menu-items/:id/outlet-price', requirePermission('pos.manage'), controller.setOutletMenuItemPrice);
  router.post('/pos/menu-items/:id/archive', requirePermission('pos.manage'), controller.archiveMenuItem);
  router.post('/pos/menu-items/:id/image', requirePermission('pos.manage'), receiveImage, controller.uploadMenuItemImage);
  router.delete('/pos/menu-items/:id/image', requirePermission('pos.manage'), controller.removeMenuItemImage);

  router.get('/pos/guests/in-house', requirePermission('pos.operate'), controller.findInHouseForCharge);

  // Staff outlet assignments: what the Register/Shifts screens may offer.
  router.get('/pos/my-outlets', requirePermission('pos.operate'), controller.getMyOutlets);
  router.get('/pos/orders', requirePermission('pos.operate'), controller.listOrders);
  router.get('/pos/tickets', requirePermission('pos.operate'), controller.listKitchenTickets);
  router.post('/pos/tickets/:id/done', requirePermission('pos.operate'), scope.orderInScope, controller.markTicketDone);
  // Shift handover — both before `/:id`, so neither word is read as a tab id.
  router.get('/pos/orders/transfer-candidates', requirePermission('pos.operate'), scope.queryOutletInScope, controller.listTransferCandidates);
  router.post('/pos/orders/transfer', requirePermission('pos.operate'), controller.transferTabs);
  router.get('/pos/orders/:id', requirePermission('pos.operate'), scope.orderInScope, controller.getOrder);
  router.post('/pos/orders', requirePermission('pos.operate'), scope.newOrderOutletInScope, controller.openOrder);
  router.post('/pos/orders/:id/items', requirePermission('pos.operate'), scope.orderInScope, controller.addItem);
  router.post('/pos/orders/:id/items/:itemId/void', requirePermission('pos.operate'), scope.orderItemInScope, controller.voidOrderItem);
  router.post('/pos/orders/:id/items/:itemId/split-group', requirePermission('pos.operate'), scope.orderItemInScope, controller.assignItemSplitGroup);
  router.post('/pos/orders/:id/rename', requirePermission('pos.operate'), scope.orderInScope, controller.renameOrder);
  router.post('/pos/orders/:id/void', requirePermission('pos.operate'), scope.orderInScope, controller.voidOrder);
  router.get('/pos/orders/:id/settlement-preview', requirePermission('pos.operate'), scope.orderInScope, controller.previewSettlement);
  router.post('/pos/orders/:id/paystack-checkout', requirePermission('pos.operate'), scope.orderInScope, controller.startPaystackCheckout);
  router.post('/pos/orders/:id/paystack-checkout/:paymentId/verify', requirePermission('pos.operate'), scope.orderInScope, controller.verifyPaystackPayment);
  router.post('/pos/orders/:id/settle', requirePermission('pos.operate'), scope.orderInScope, controller.settleOrder);
  router.post('/pos/orders/:id/settlements/:settlementId/void', requirePermission('pos.manage'), controller.voidSettlement);

  // A reconciliation report, not a till action — manager tier, like the other POS overrides.
  // Profit on this report uses recipe/cost data that is otherwise `pos.stock_manage`-only. Today every role holding `pos.manage` also holds `pos.stock_manage`; if that ever changes, gate the profit fields separately.
  router.get('/pos/reports/sales', requirePermission('pos.manage'), controller.salesReport);

  router.get('/pos/shifts', requirePermission('pos.operate'), controller.listShifts);
  router.get('/pos/shifts/:id', requirePermission('pos.operate'), scope.shiftInScope, controller.getShift);
  router.post('/pos/shifts', requirePermission('pos.operate'), scope.newShiftTerminalInScope, controller.openShift);
  router.post('/pos/shifts/:id/close', requirePermission('pos.operate'), controller.closeShift);

  return router;
}

module.exports = { posRouter };
