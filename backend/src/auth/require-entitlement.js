'use strict';

/**
 * Route-level plan entitlement gate — PLAN.md Phase 5's "a tenant on a lower
 * plan calling a gated endpoint directly is rejected", for a capability that
 * is all-or-nothing per request.
 *
 * `createProperty`'s `multi_property` check stays inline in its service: it
 * is count-dependent (a first property is always allowed), which no
 * stateless per-route check can express. Door access monitoring (PLAN.md
 * Phase 7) is the first genuinely count-independent gated capability — the
 * case SECURITY.md §5's entitlement paragraph named as the natural point to
 * add this middleware.
 *
 * Mount AFTER `requirePermission`: the permission check is role-specific and
 * cheaper; this one answers the separate "does the tenant's plan include it
 * at all" question, and applies to every role equally — a super_admin on a
 * plan without the feature is refused exactly like anyone else.
 *
 * Fail-closed via `hasEntitlement` (a misconfigured catalogue is "not
 * entitled", never a 500).
 */

const { scopedDb } = require('../db');
const { hasEntitlement, resolveActivePlanId } = require('../shared/entitlements');
const { PlanEntitlementDeniedError } = require('./errors');

function requireEntitlement(featureKey) {
  return async function requireEntitlementMiddleware(req, res, next) {
    try {
      const db = scopedDb().for(req.context);
      const tenant = await db.table('tenants').first();
      if (!(await hasEntitlement(db, tenant, featureKey))) {
        const planId = await resolveActivePlanId(db, tenant);
        const plan = planId ? await db.reference().table('plans').where({ id: planId }).first('code') : null;
        throw new PlanEntitlementDeniedError(featureKey, plan ? plan.code : null);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { requireEntitlement };
