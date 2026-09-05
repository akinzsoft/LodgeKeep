'use strict';

/**
 * Route wiring for the housekeeping module — PLAN.md Phase 3. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()` are already applied router-wide, same as every other
 * business module.
 *
 * SECURITY.md §5's matrix row for Housekeeping: `housekeeping`/`manager`/
 * `admin`/`super_admin` get full access; `front_desk` gets Read only;
 * `cashier`/`pos_operator` get neither key.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function housekeepingRouter() {
  const router = Router();

  router.get('/housekeeping/board', requirePermission('housekeeping.view'), controller.listBoard);
  router.post('/housekeeping/assignments', requirePermission('housekeeping.manage'), controller.createAssignment);
  router.patch('/housekeeping/assignments/:id', requirePermission('housekeeping.manage'), controller.updateAssignment);

  router.post('/housekeeping/rooms/:roomId/status', requirePermission('housekeeping.manage'), controller.reportRoomStatus);

  router.get('/housekeeping/discrepancies', requirePermission('housekeeping.view'), controller.listDiscrepancies);
  router.post('/housekeeping/discrepancies/:id/resolve', requirePermission('housekeeping.manage'), controller.resolveDiscrepancy);

  router.get('/housekeeping/out-of-order', requirePermission('housekeeping.view'), controller.listOutOfOrderPeriods);
  router.post('/housekeeping/out-of-order', requirePermission('housekeeping.manage'), controller.createOutOfOrderPeriod);
  router.patch('/housekeeping/out-of-order/:id', requirePermission('housekeeping.manage'), controller.closeOutOfOrderPeriod);

  return router;
}

module.exports = { housekeepingRouter };
