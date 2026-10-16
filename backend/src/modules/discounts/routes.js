'use strict';

/**
 * Discount routes. `discount.apply` gives a discount within your limit; the manager's PIN approval (not a permission
 * on the caller) is what lets one above the limit, or a comp, take effect. Reasons and limits are `discount.manage`.
 * Mounted after `authenticate('staff')` and `attachAudit()`.
 */

const { Router } = require('express');
const controller = require('./controller');
const scope = require('../pos/outlet-scope');
const { refuseSupermarketTab } = require('../pos/register-guard');
const { requirePermission, requireAnyPermission } = require('../../auth');

function discountsRouter() {
  const router = Router();

  router.get('/discounts/reasons', requireAnyPermission(['discount.apply', 'discount.manage']), controller.listReasons);
  router.post('/discounts/reasons', requirePermission('discount.manage'), controller.createReason);
  router.patch('/discounts/reasons/:id', requirePermission('discount.manage'), controller.updateReason);
  router.get('/discounts/limits', requireAnyPermission(['discount.apply', 'discount.manage']), controller.listLimits);
  router.put('/discounts/limits/:role', requirePermission('discount.manage'), controller.setLimit);
  router.get('/discounts/report', requirePermission('reports.view_discounts'), controller.report);

  // A Register check's discounts. The check must be at an outlet the caller covers, and not a supermarket's.
  router.get('/pos/orders/:id/discounts', requirePermission('pos.operate'), scope.orderInScope, controller.listOrderDiscounts);
  router.post('/pos/orders/:id/discounts', requirePermission('pos.operate'), requirePermission('discount.apply'), scope.orderInScope, refuseSupermarketTab, controller.createOrderDiscount);

  // The supermarket till asks before the sale exists; the sale then claims the approved request.
  router.post('/supermarket/discounts', requirePermission('supermarket.sales'), requirePermission('discount.apply'), controller.createCartDiscount);

  router.get('/discounts/:id', requireAnyPermission(['pos.operate', 'supermarket.sales']), controller.getDiscount);
  router.post('/discounts/:id/approve', requireAnyPermission(['pos.operate', 'supermarket.sales']), controller.approveDiscount);
  router.post('/discounts/:id/remove', requirePermission('discount.apply'), controller.removeDiscount);

  return router;
}

module.exports = { discountsRouter };
