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
 *
 * `setRefreshTokenCookie`/`REFRESH_TOKEN_MAX_AGE_MS` joined this surface for
 * a PLAN.md Phase 5 gap closure: `src/modules/signup`'s `issueStaffSession`
 * call mints a refresh token exactly like `staffLogin` does, but signup's
 * own controller (outside `buildStaffRouter()` entirely — see that module's
 * `routes.js` header) had never been updated to deliver it as the same
 * HttpOnly cookie `/auth/login`/`/auth/refresh` use, so it was leaking into
 * the JSON response body instead. `stripRefreshToken` itself is NOT
 * re-exported here — it is a one-line, response-shaping destructure with no
 * real logic to share, so `signup/controller.js` keeps its own tiny copy
 * rather than growing this surface for something that trivial (the same
 * "duplicate a one-off, don't force a shared home for it" reasoning
 * `billing/health.js`'s own `resolvePlanForRoster` already established for
 * an equally small function).
 */

const { staffAuthRouter, portalAuthRouter, platformAuthRouter } = require('./routes');
const { authenticate } = require('./middleware');
const { requirePermission } = require('./rbac');
const { requirePlatformRole } = require('./platform-rbac');
const { writeAuthEvent } = require('./events');
const { rejectMutationDuringImpersonation } = require('./impersonation-guard');
const { rejectMutationForTenantLifecycle } = require('./tenant-lifecycle-guard');
const { issueStaffSession } = require('./service');
const { hashPassword, validatePassword } = require('./password');
const { setRefreshTokenCookie, refreshTokenMaxAgeMs } = require('./refresh-cookie');
const { REFRESH_TTL_HOURS } = require('./tokens');

module.exports = {
  staffAuthRouter,
  portalAuthRouter,
  platformAuthRouter,
  authenticate,
  requirePermission,
  requirePlatformRole,
  writeAuthEvent,
  rejectMutationDuringImpersonation,
  rejectMutationForTenantLifecycle,
  issueStaffSession,
  hashPassword,
  validatePassword,
  setRefreshTokenCookie,
  REFRESH_TOKEN_MAX_AGE_MS: refreshTokenMaxAgeMs(REFRESH_TTL_HOURS),
};
