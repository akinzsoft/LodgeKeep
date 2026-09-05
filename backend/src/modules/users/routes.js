'use strict';

/**
 * Route wiring for user management — PLAN.md Phase 1 gap closure. Mounted
 * under `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()` are already applied router-wide, the same position every
 * other business router (`setupRouter`, `reservationsRouter`, ...) mounts
 * at. Reuses `setup.view`/`setup.manage` rather than a new permission
 * domain — PRODUCT_REQUIREMENTS.md §3.19 files "User & staff setup" under
 * the same Setup module these two keys already gate.
 *
 * Accepting an invitation is deliberately NOT here — it runs before a
 * caller has any token at all, so it lives on the public, pre-`authenticate`
 * part of `src/auth`'s own router tree instead (see that module's
 * `acceptInvitation`).
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function usersRouter() {
  const router = Router();

  router.get('/users', requirePermission('setup.view'), controller.listUsers);
  router.get('/users/pending-invitations', requirePermission('setup.view'), controller.listPendingInvitations);
  router.post('/users/invite', requirePermission('setup.manage'), controller.inviteUser);
  router.post('/users/:id/deactivate', requirePermission('setup.manage'), controller.deactivateUser);
  router.patch('/users/:id/role', requirePermission('setup.manage'), controller.changeUserRole);

  return router;
}

module.exports = { usersRouter };
