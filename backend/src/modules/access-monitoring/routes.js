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

const { MAX_UPLOAD_BYTES } = require('./spreadsheet');
const { ValidationError } = require('../../shared/errors');

const multerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
/** `upload.single('file')`, but a file over the size cap is the same clear 400 every other import limit gives, not a raw multer error. */
const upload = {
  single: (field) => (req, res, next) =>
    multerUpload.single(field)(req, res, (error) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return next(new ValidationError('DOOR_ACCESS_FILE_TOO_LARGE', `The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Export a shorter date range.`));
      }
      return next(error);
    }),
};
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
