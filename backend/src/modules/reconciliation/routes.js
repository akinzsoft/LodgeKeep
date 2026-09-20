'use strict';

/**
 * Route wiring for the payment reconciliation report. Mounted under
 * `/api/v1` in `src/app.js`, same `authenticate('staff')`/`attachAudit()`
 * pipeline every other business router already sits in.
 *
 * Confirmed RBAC decision: a genuinely new, narrowly-scoped
 * `reconciliation.view` key rather than reusing `cashiering.void_line` or
 * `pos.manage` — this report spans both of those modules' own money data
 * at once, and reusing either would tie this report's access to a future
 * RBAC change in an unrelated module as a side effect. Manager/admin/
 * super_admin only — see that permission's own seed migration and
 * SECURITY.md §5.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function reconciliationRouter() {
  const router = Router();

  router.get('/reconciliation/payments', requirePermission('reconciliation.view'), controller.paymentsReport);

  return router;
}

module.exports = { reconciliationRouter };
