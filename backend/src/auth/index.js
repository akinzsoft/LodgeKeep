'use strict';

/**
 * `src/auth`'s public surface — ARCHITECTURE.md §2 lists this alongside
 * `/audit` and `/jobs` as top-level, not under `/modules`, since it is
 * cross-cutting infrastructure every module's routes sit behind rather than a
 * single business domain.
 *
 * Other code imports from here, never from the files behind it (CLAUDE.md's
 * module-boundary rule) — `authenticate` is what a future module's protected
 * routes are built with; the route factories are what `src/app.js` mounts.
 *
 * `writeAuthEvent` joined this surface for PLAN.md Phase 1 gap closure's
 * user-management module (`src/modules/users`): `auth_events.event_type`'s
 * enum has carried `user_deactivated` since Phase 0, clearly meant for
 * exactly this identity-lifecycle action, and a business module deactivating
 * a user needs a sanctioned way to record it there rather than reaching
 * around this file into `src/auth/events.js` directly.
 */

const { staffAuthRouter, portalAuthRouter, platformAuthRouter } = require('./routes');
const { authenticate } = require('./middleware');
const { requirePermission } = require('./rbac');
const { writeAuthEvent } = require('./events');

module.exports = {
  staffAuthRouter,
  portalAuthRouter,
  platformAuthRouter,
  authenticate,
  requirePermission,
  writeAuthEvent,
};
