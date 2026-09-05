'use strict';

/**
 * Route wiring for the notifications module — PLAN.md Phase 3. Mounted
 * under `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()` are already applied router-wide.
 *
 * SECURITY.md §5 has no Notifications row (confirmed by reading that file
 * directly) — this session's confirmed decision follows Setup's own shape:
 * `notifications.view` (delivery log, read-only) for manager/admin/
 * super_admin, `notifications.manage` (templates, resend) for admin/
 * super_admin only. The in-app bell itself needs no permission at all —
 * every authenticated staff member reads only their own notifications.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function notificationsRouter() {
  const router = Router();

  router.get('/notifications/templates', requirePermission('notifications.manage'), controller.listTemplates);
  router.put('/notifications/templates', requirePermission('notifications.manage'), controller.upsertTemplate);

  router.get('/notifications/log', requirePermission('notifications.view'), controller.listNotificationLog);
  router.post('/notifications/log/:id/resend', requirePermission('notifications.manage'), controller.resendNotification);

  router.get('/notifications/bell', controller.listInAppNotifications);
  router.post('/notifications/bell/:id/read', controller.markNotificationRead);

  return router;
}

module.exports = { notificationsRouter };
