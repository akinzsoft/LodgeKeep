'use strict';

/**
 * Route wiring for the night-audit module — PLAN.md Phase 2.5. Mounted
 * under `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()`, same as every other business module.
 *
 * SECURITY.md §5 has no Night Audit row at all (confirmed by reading that
 * file directly) — this session's confirmed decision, seeded by
 * `20260909097000_seed_night_audit_permissions.js`: closing a business
 * date is manager-level, not operational — manager/admin/super_admin only.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function nightAuditRouter() {
  const router = Router();

  router.get('/night-audit/runs', requirePermission('night_audit.view'), controller.listRuns);
  router.get('/night-audit/runs/:id', requirePermission('night_audit.view'), controller.getRun);
  router.post('/night-audit/run', requirePermission('night_audit.run'), controller.runNightAudit);
  router.get('/night-audit/daily-reports/:businessDate', requirePermission('night_audit.view'), controller.getDailyReport);

  return router;
}

module.exports = { nightAuditRouter };
