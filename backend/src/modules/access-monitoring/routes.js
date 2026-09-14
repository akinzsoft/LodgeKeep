'use strict';

/**
 * Door access monitoring routes — PLAN.md Phase 7, PRODUCT_REQUIREMENTS.md
 * §3.23. Manager/admin/super_admin only (`door_access.view` /
 * `door_access.manage`), and every route additionally requires the tenant's
 * plan to include `door_access_monitoring`.
 *
 * Uploads use multer's memory storage: the import flow is stateless (see
 * service.js), so the file never touches disk and nothing needs cleaning up.
 */

const { Router } = require('express');
const multer = require('multer');
const controller = require('./controller');
const { requirePermission, requireEntitlement } = require('../../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const FEATURE_KEY = 'door_access_monitoring';

function accessMonitoringRouter() {
  const router = Router();
  const view = [requirePermission('door_access.view'), requireEntitlement(FEATURE_KEY)];
  const manage = [requirePermission('door_access.manage'), requireEntitlement(FEATURE_KEY)];

  router.get('/door-access/config', ...view, controller.getConfig);
  router.put('/door-access/config', ...manage, controller.updateConfig);

  router.post('/door-access/imports/headers', ...manage, upload.single('file'), controller.readHeaders);
  router.post('/door-access/imports/preview', ...manage, upload.single('file'), controller.previewImport);
  router.post('/door-access/imports/commit', ...manage, upload.single('file'), controller.commitImport);

  router.get('/door-access/alerts', ...view, controller.listAlerts);
  router.get('/door-access/alerts/:id', ...view, controller.getAlert);
  router.post('/door-access/alerts/:id/acknowledge', ...manage, controller.acknowledgeAlert);
  router.post('/door-access/alerts/:id/resolve', ...manage, controller.resolveAlert);

  router.get('/door-access/stay-confirmations', ...view, controller.listStayConfirmations);

  return router;
}

module.exports = { accessMonitoringRouter };
