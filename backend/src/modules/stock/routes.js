'use strict';

/**
 * Route wiring for the stock module — PLAN.md Phase 6. Mounted under
 * `/api/v1` in `src/app.js`, immediately after `posRouter()`, same
 * `authenticate('staff')`/`attachAudit()` pipeline every other business
 * router already sits in.
 *
 * Two keys (this session's confirmed RBAC decision): `pos.stock_view`
 * (pos_operator/manager/admin/super_admin — read stock levels/alerts,
 * record wastage with a mandatory reason) and `pos.stock_manage`
 * (manager/admin/super_admin only — stock item CRUD, recipe/BOM, goods
 * received, the full stock-take lifecycle, cost/variance reporting).
 *
 * A third, `pos.stock_transfer` (storekeeper/manager/admin/super_admin):
 * issue stock from one outlet to another, and read the transfer history
 * (quantities only, no cost). Its own key, not either of the two above,
 * so a Storekeeper can move stock without selling at the Register
 * (`pos.operate`) or editing items and seeing cost reports
 * (`pos.stock_manage`).
 *
 * Transfer requests: `pos.stock_request` (pos_operator/manager/admin/
 * super_admin) raises and withdraws a request; `pos.stock_transfer`
 * issues or rejects it — issuing IS transferring, so it needs the same
 * key. Either key reads the list (a requester follows what they asked
 * for; a storekeeper works through what is pending).
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission, requireAnyPermission } = require('../../auth');

function stockRouter() {
  const router = Router();

  router.get('/pos/stock/categories', requirePermission('pos.stock_view'), controller.listStockItemCategories);
  router.post('/pos/stock/categories', requirePermission('pos.stock_manage'), controller.createStockItemCategory);
  router.patch('/pos/stock/categories/:id', requirePermission('pos.stock_manage'), controller.updateStockItemCategory);
  router.post('/pos/stock/categories/:id/archive', requirePermission('pos.stock_manage'), controller.archiveStockItemCategory);

  router.get('/pos/stock/items', requirePermission('pos.stock_view'), controller.listStockItems);
  router.post('/pos/stock/items', requirePermission('pos.stock_manage'), controller.createStockItem);
  router.patch('/pos/stock/items/:id', requirePermission('pos.stock_manage'), controller.updateStockItem);
  router.post('/pos/stock/items/:id/archive', requirePermission('pos.stock_manage'), controller.archiveStockItem);
  router.post('/pos/stock/items/:id/wastage', requirePermission('pos.stock_view'), controller.recordWastage);
  router.get('/pos/stock/items/:id/levels', requirePermission('pos.stock_view'), controller.listStockLevels);

  router.get('/pos/stock/menu-links', requirePermission('pos.stock_manage'), controller.listMenuItemLinks);
  router.get('/pos/stock/menu-items/:menuItemId/components', requirePermission('pos.stock_manage'), controller.listMenuItemComponents);
  router.put('/pos/stock/menu-items/:menuItemId/components', requirePermission('pos.stock_manage'), controller.upsertMenuItemComponents);

  router.post('/pos/stock/goods-received', requirePermission('pos.stock_manage'), controller.recordGoodsReceived);
  // Gated the same as the reporting endpoints below, not the plainer
  // pos.stock_view: a movement row carries unit_cost/total_cost, real cost
  // data — gap closure, backing Goods Received's own "recent deliveries".
  router.get('/pos/stock/movements', requirePermission('pos.stock_manage'), controller.listStockMovements);

  router.post('/pos/stock/transfers', requirePermission('pos.stock_transfer'), controller.transferStock);
  router.get('/pos/stock/transfers', requirePermission('pos.stock_transfer'), controller.listTransfers);

  const readRequests = requireAnyPermission(['pos.stock_request', 'pos.stock_transfer']);
  router.get('/pos/stock/transfer-requests', readRequests, controller.listTransferRequests);
  // Before `/:id`, so "my-outlets" is never read as a request id.
  router.get('/pos/stock/transfer-requests/my-outlets', readRequests, controller.getMyRequestOutlets);
  // The sign-in reminder: pending requests waiting on the caller to issue (before `/:id`).
  router.get('/pos/stock/transfer-requests/awaiting-me', requirePermission('pos.stock_transfer'), controller.listRequestsAwaitingMe);
  router.get('/pos/stock/transfer-requests/:id', readRequests, controller.getTransferRequest);
  router.post('/pos/stock/transfer-requests', requirePermission('pos.stock_request'), controller.createTransferRequest);
  router.post('/pos/stock/transfer-requests/:id/issue', requirePermission('pos.stock_transfer'), controller.issueTransferRequest);
  router.post('/pos/stock/transfer-requests/:id/reject', requirePermission('pos.stock_transfer'), controller.rejectTransferRequest);
  router.post('/pos/stock/transfer-requests/:id/cancel', requirePermission('pos.stock_request'), controller.cancelTransferRequest);

  router.get('/pos/stock/takes', requirePermission('pos.stock_manage'), controller.listStockTakes);
  router.get('/pos/stock/takes/:id', requirePermission('pos.stock_manage'), controller.getStockTake);
  router.post('/pos/stock/takes', requirePermission('pos.stock_manage'), controller.openStockTake);
  router.patch('/pos/stock/takes/:id/lines/:stockItemId', requirePermission('pos.stock_manage'), controller.recordStockTakeCount);
  router.post('/pos/stock/takes/:id/complete', requirePermission('pos.stock_manage'), controller.completeStockTake);
  router.post('/pos/stock/takes/:id/cancel', requirePermission('pos.stock_manage'), controller.cancelStockTake);

  router.get('/pos/stock/reports/cost-of-sales', requirePermission('pos.stock_manage'), controller.costOfSales);
  router.get('/pos/stock/reports/variance', requirePermission('pos.stock_manage'), controller.stockVariance);
  router.get('/pos/stock/reports/margin', requirePermission('pos.stock_manage'), controller.costOfSalesMargin);
  router.get('/pos/stock/reports/overview', requirePermission('pos.stock_manage'), controller.stockOverview);

  return router;
}

module.exports = { stockRouter };
