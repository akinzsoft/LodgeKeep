'use strict';

/**
 * Platform-staff tiering — PLAN.md Phase 5, SECURITY.md §2, revisited once
 * self-service tenant signup meant impersonation could reach real customer
 * data rather than only internally-seeded test tenants.
 *
 * Deliberately NOT `requirePermission`'s shape (`rbac.js`): there is no
 * permission catalogue, no `role_permissions` join, no per-endpoint "Limited"
 * definition for platform staff — just two tiers and one equality check,
 * matching `room_types.update`'s own minimal admin/super_admin split rather
 * than inventing a parallel RBAC system for a population that (per
 * SECURITY.md §2's own text) is "an internal, trusted-engineer tool," not a
 * multi-role organization.
 *
 * Mount after `authenticate('platform')`, which supplies `req.context.role`
 * (`src/auth/middleware.js`'s platform branch — the live value, re-queried
 * every request, never trusted from the token).
 */

const { PlatformRoleDeniedError } = require('./errors');

function requirePlatformRole(requiredRole) {
  return function requirePlatformRoleMiddleware(req, res, next) {
    if (req.context?.role !== requiredRole) {
      return next(new PlatformRoleDeniedError(requiredRole, req.context?.role ?? null));
    }
    next();
  };
}

module.exports = { requirePlatformRole };
