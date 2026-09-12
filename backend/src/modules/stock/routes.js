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
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function stockRouter() {
  const router = Router();

  router.get('/pos/stock/items', requirePermission('pos.stock_view'), controller.listStockItems);
  router.post('/pos/stock/items', requirePermission('pos.stock_manage'), controller.createStockItem);
  router.patch('/pos/stock/items/:id', requirePermission('pos.stock_manage'), controller.updateStockItem);
  router.post('/pos/stock/items/:id/archive', requirePermission('pos.stock_manage'), controller.archiveStockItem);
  router.post('/pos/stock/items/:id/wastage', requirePermission('pos.stock_view'), controller.recordWastage);

  router.get('/pos/stock/menu-items/:menuItemId/components', requirePermission('pos.stock_manage'), controller.listMenuItemComponents);
  router.put('/pos/stock/menu-items/:menuItemId/components', requirePermission('pos.stock_manage'), controller.upsertMenuItemComponents);

  router.post('/pos/stock/goods-received', requirePermission('pos.stock_manage'), controller.recordGoodsReceived);

  router.get('/pos/stock/takes', requirePermission('pos.stock_manage'), controller.listStockTakes);
  router.get('/pos/stock/takes/:id', requirePermission('pos.stock_manage'), controller.getStockTake);
  router.post('/pos/stock/takes', requirePermission('pos.stock_manage'), controller.openStockTake);
  router.patch('/pos/stock/takes/:id/lines/:stockItemId', requirePermission('pos.stock_manage'), controller.recordStockTakeCount);
  router.post('/pos/stock/takes/:id/complete', requirePermission('pos.stock_manage'), controller.completeStockTake);
  router.post('/pos/stock/takes/:id/cancel', requirePermission('pos.stock_manage'), controller.cancelStockTake);

  router.get('/pos/stock/reports/cost-of-sales', requirePermission('pos.stock_manage'), controller.costOfSales);
  router.get('/pos/stock/reports/variance', requirePermission('pos.stock_manage'), controller.stockVariance);

  return router;
}

module.exports = { stockRouter };
