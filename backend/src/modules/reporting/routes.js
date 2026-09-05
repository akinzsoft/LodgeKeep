'use strict';

/**
 * Route wiring for the reporting module — PLAN.md Phase 3. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()` are already applied router-wide.
 *
 * SECURITY.md §5's matrix: `reports.view` (occupancy, housekeeping — no
 * financial figures) is front_desk/cashier's "Limited" cell, defined here
 * per that section's own rule; manager/admin/super_admin additionally hold
 * `reports.view_financial` for the revenue report. Housekeeping/pos_operator
 * hold neither key.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function reportingRouter() {
  const router = Router();

  router.get('/reports/occupancy', requirePermission('reports.view'), controller.occupancy);
  router.get('/reports/housekeeping', requirePermission('reports.view'), controller.housekeepingSummary);
  router.get('/reports/oversold', requirePermission('reports.view'), controller.oversoldRoomTypes);
  router.get('/reports/revenue', requirePermission('reports.view_financial'), controller.revenue);

  return router;
}

module.exports = { reportingRouter };
