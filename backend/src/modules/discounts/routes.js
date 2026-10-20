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
const { redisRateLimiter } = require('../../shared/rate-limit');

const WINDOW_MS = 15 * 60_000;
const numberFromEnv = (name, fallback) => (Number.isInteger(Number(process.env[name])) && Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);

/**
 * Typing a voucher code is the one place a stranger's guess meets the database, so it is rate-limited twice: per signed-in
 * user and per IP (a till behind one address still gets a generous shared budget). Every attempt counts, whatever the answer.
 */
const voucherUserLimiter = () => redisRateLimiter({
  windowMs: WINDOW_MS,
  limit: numberFromEnv('VOUCHER_USER_LIMIT', 20),
  prefix: 'voucher-user:',
  message: 'Too many voucher attempts. Wait a few minutes and try again.',
  keyGenerator: (req) => `u:${req.context?.tenantId ?? 'x'}:${req.context?.userId ?? 'x'}`,
});
const voucherIpLimiter = () => redisRateLimiter({
  windowMs: WINDOW_MS,
  limit: numberFromEnv('VOUCHER_IP_LIMIT', 60),
  prefix: 'voucher-ip:',
  message: 'Too many voucher attempts from this address. Wait a few minutes and try again.',
});

function discountsRouter() {
  const router = Router();

  router.get('/discounts/reasons', requireAnyPermission(['discount.apply', 'discount.manage']), controller.listReasons);
  router.post('/discounts/reasons', requirePermission('discount.manage'), controller.createReason);
  router.patch('/discounts/reasons/:id', requirePermission('discount.manage'), controller.updateReason);
  router.get('/discounts/limits', requireAnyPermission(['discount.apply', 'discount.manage']), controller.listLimits);
  router.put('/discounts/limits/:role', requirePermission('discount.manage'), controller.setLimit);
  // Vouchers: a manager makes and disables them; a cashier only types a code.
  router.get('/discounts/vouchers', requirePermission('discount.manage'), controller.listVouchers);
  router.post('/discounts/vouchers', requirePermission('discount.manage'), controller.createVoucher);
  router.post('/discounts/vouchers/:id/disable', requirePermission('discount.manage'), controller.disableVoucher);
  router.post('/discounts/vouchers/:id/enable', requirePermission('discount.manage'), controller.enableVoucher);

  router.get('/discounts/report', requirePermission('reports.view_discounts'), controller.report);

  // A Register check's discounts. The check must be at an outlet the caller covers, and not a supermarket's.
  router.get('/pos/orders/:id/discounts', requirePermission('pos.operate'), scope.orderInScope, controller.listOrderDiscounts);
  router.post('/pos/orders/:id/discounts', requirePermission('pos.operate'), requirePermission('discount.apply'), scope.orderInScope, refuseSupermarketTab, controller.createOrderDiscount);

  router.post('/pos/orders/:id/voucher', requirePermission('pos.operate'), requirePermission('discount.apply'), voucherIpLimiter(), voucherUserLimiter(), scope.orderInScope, refuseSupermarketTab, controller.applyOrderVoucher);

  // The supermarket till asks before the sale exists; the sale then claims the approved request.
  router.post('/supermarket/discounts', requirePermission('supermarket.sales'), requirePermission('discount.apply'), controller.createCartDiscount);

  router.post('/supermarket/voucher', requirePermission('supermarket.sales'), requirePermission('discount.apply'), voucherIpLimiter(), voucherUserLimiter(), controller.applyCartVoucher);

  router.get('/discounts/:id', requireAnyPermission(['pos.operate', 'supermarket.sales']), controller.getDiscount);
  router.post('/discounts/:id/approve', requireAnyPermission(['pos.operate', 'supermarket.sales']), controller.approveDiscount);
  router.post('/discounts/:id/remove', requirePermission('discount.apply'), controller.removeDiscount);

  return router;
}

module.exports = { discountsRouter };
