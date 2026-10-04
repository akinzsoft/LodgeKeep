'use strict';

/**
 * Supermarket quick-sale routes. Three keys: `supermarket.sales` sells (and
 * may read the receipt it rang), `supermarket.report` reads sales and reports
 * without being able to sell, `supermarket.manage` handles barcodes and voids.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission, requireAnyPermission } = require('../../auth');

function supermarketRouter() {
  const router = Router();
  const readSales = requireAnyPermission(['supermarket.sales', 'supermarket.report']);

  router.get('/supermarket/my-outlets', requireAnyPermission(['supermarket.sales', 'supermarket.report', 'supermarket.manage']), controller.listMyOutlets);
  router.get('/supermarket/lookup', requirePermission('supermarket.sales'), controller.lookup);
  router.post('/supermarket/sales', requirePermission('supermarket.sales'), controller.createSale);
  router.get('/supermarket/sales', requirePermission('supermarket.report'), controller.listSales);
  router.get('/supermarket/report', requirePermission('supermarket.report'), controller.summary);
  router.get('/supermarket/setup-flags', requirePermission('supermarket.manage'), controller.setupFlags);
  router.get('/supermarket/low-stock', requireAnyPermission(['supermarket.sales', 'supermarket.report', 'supermarket.manage']), controller.lowStock);
  router.get('/supermarket/my-sales', requirePermission('supermarket.sales'), controller.mySales);
  router.get('/supermarket/sales/:id', readSales, controller.getSale);
  router.post('/supermarket/sales/:id/void', requirePermission('supermarket.manage'), controller.voidSale);

  router.get('/supermarket/barcodes', requirePermission('supermarket.manage'), controller.listBarcodes);
  router.post('/supermarket/barcodes', requirePermission('supermarket.manage'), controller.addBarcode);
  router.delete('/supermarket/barcodes/:id', requirePermission('supermarket.manage'), controller.removeBarcode);

  return router;
}

module.exports = { supermarketRouter };
