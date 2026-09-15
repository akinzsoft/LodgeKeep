'use strict';

/**
 * Route wiring for the expenses module. Mounted under `/api/v1` in
 * `src/app.js`, same `authenticate('staff')`/`attachAudit()` pipeline
 * every other business router already sits in.
 *
 * Confirmed RBAC decision: `expenses.view`/`expenses.manage`, both
 * manager/admin/super_admin only — no front-desk/cashier/housekeeping/
 * pos_operator access at all (matches Night Audit's/Billing's shape).
 * Report routes are gated on `expenses.view` alone, not additionally
 * `reports.view_financial` — requiring a second key would be redundant
 * given `expenses.view` is already this tightly restricted.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function expensesRouter() {
  const router = Router();

  router.get('/expenses/categories', requirePermission('expenses.view'), controller.listExpenseCategories);
  router.post('/expenses/categories', requirePermission('expenses.manage'), controller.createExpenseCategory);
  router.patch('/expenses/categories/:id', requirePermission('expenses.manage'), controller.updateExpenseCategory);
  router.post('/expenses/categories/:id/archive', requirePermission('expenses.manage'), controller.archiveExpenseCategory);

  router.get('/expenses/recurring-schedules', requirePermission('expenses.view'), controller.listRecurringExpenseSchedules);
  router.get('/expenses/recurring-schedules/:id', requirePermission('expenses.view'), controller.getRecurringExpenseSchedule);
  router.post('/expenses/recurring-schedules', requirePermission('expenses.manage'), controller.createRecurringExpenseSchedule);
  router.patch('/expenses/recurring-schedules/:id', requirePermission('expenses.manage'), controller.updateRecurringExpenseSchedule);
  router.post('/expenses/recurring-schedules/:id/pause', requirePermission('expenses.manage'), controller.pauseRecurringExpenseSchedule);
  router.post('/expenses/recurring-schedules/:id/resume', requirePermission('expenses.manage'), controller.resumeRecurringExpenseSchedule);

  // Static report paths, ahead of no `:id` route they could ever collide
  // with here (this module's own `:id` routes are all further up).
  router.get('/expenses/reports/summary', requirePermission('expenses.view'), controller.getExpenseReport);
  router.get('/expenses/reports/profit', requirePermission('expenses.view'), controller.getProfitSummary);

  router.get('/expenses', requirePermission('expenses.view'), controller.listExpenses);
  router.get('/expenses/:id', requirePermission('expenses.view'), controller.getExpense);
  router.post('/expenses', requirePermission('expenses.manage'), controller.recordExpense);
  router.post('/expenses/:id/void', requirePermission('expenses.manage'), controller.voidExpense);

  return router;
}

module.exports = { expensesRouter };
