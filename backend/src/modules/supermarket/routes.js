'use strict';

/**
 * Supermarket quick-sale routes. Three keys: `supermarket.sales` sells (and
 * may read the receipt it rang), `supermarket.report` reads sales and reports
 * without being able to sell, `supermarket.manage` handles barcodes, voids and
 * the product import.
 */

const { Router } = require('express');
const controller = require('./controller');
const imports = require('./import-controller');
const { requirePermission, requireAnyPermission } = require('../../auth');
// Stage 3 product import: the same CSV upload (disk storage, 20 MB cap) as Data Migration.
const { csvUpload: upload } = require('../migration/storage');

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

  // Stage 3: bulk CSV product import (all-or-nothing; undo removes untouched products).
  const manage = requirePermission('supermarket.manage');
  router.get('/supermarket/imports/template', manage, imports.downloadTemplate);
  router.get('/supermarket/imports', manage, imports.listImports);
  router.post('/supermarket/imports', manage, upload.single('file'), imports.uploadImport);
  router.get('/supermarket/imports/:id', manage, imports.getImport);
  router.post('/supermarket/imports/:id/dry-run', manage, imports.dryRun);
  router.post('/supermarket/imports/:id/commit', manage, imports.commit);
  router.post('/supermarket/imports/:id/rollback', manage, imports.rollback);

  return router;
}

module.exports = { supermarketRouter };
