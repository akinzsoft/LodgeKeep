'use strict';

/**
 * Plan entitlement resolution — PLAN.md Phase 5's own final exit criterion
 * ("a tenant on a lower plan calling a gated endpoint directly is
 * rejected"), PRODUCT_REQUIREMENTS.md §3.22, `plan_entitlements`
 * (20260926090000_create_plan_entitlements).
 *
 * Lives in `src/shared`, not `src/modules/billing`, deliberately: this is
 * cross-cutting policy any module may eventually need to consult
 * (mirroring `src/shared/tenant-lifecycle.js`'s own placement), and this
 * codebase's own module-boundary rule only ever lets a business module
 * depend on shared infra, never the reverse — `src/shared` must not import
 * `src/modules/billing`.
 *
 * `resolveActivePlanId` below therefore DUPLICATES, rather than imports,
 * `billing/service.js`'s `resolveDefaultPlan`/`resolvePlanFor` query — the
 * two must behave identically for the same input ("no plan set -> the one
 * active default plan"), but the dependency direction that would let one
 * reuse the other doesn't exist in this codebase's layering. Billing's own
 * version throws `NoActivePlanError` when no active plan exists at all,
 * because billing genuinely cannot proceed without one; this version
 * returns `null` instead and `hasEntitlement` treats that as "not
 * entitled" — fails CLOSED rather than throwing a 500, since this
 * primitive is meant to be safely callable from any route or service, and
 * a misconfigured plan catalogue must never turn into an unrelated 500 on
 * every request that happens to check an entitlement.
 */

/**
 * @param {object} db - a context-bound accessor (`scopedDb().for(context)`,
 *   or the accessor handed into a `db.transaction()` callback) — only
 *   `.reference()` is used, which requires no particular audience beyond
 *   the caller already having resolved one.
 * @param {{plan_id?: string|number|null}} tenant - a `tenants` row, or any
 *   object carrying that one field.
 * @returns {Promise<string|number|null>}
 */
async function resolveActivePlanId(db, tenant) {
  if (tenant && tenant.plan_id) return tenant.plan_id;
  const plan = await db.reference().table('plans').where({ is_active: true }).orderBy('id').first('id');
  return plan ? plan.id : null;
}

/**
 * Does this tenant's plan grant `featureKey`? Fails closed: no resolvable
 * plan, or no matching `plan_entitlements` row, both mean "not entitled" —
 * never a thrown error, so a caller (route or service) can use this
 * directly in an `if` without its own try/catch.
 *
 * @param {object} db
 * @param {{plan_id?: string|number|null}} tenant
 * @param {string} featureKey
 * @returns {Promise<boolean>}
 */
async function hasEntitlement(db, tenant, featureKey) {
  const planId = await resolveActivePlanId(db, tenant);
  if (!planId) return false;
  const row = await db
    .reference()
    .table('plan_entitlements')
    .where({ plan_id: planId, feature_key: featureKey })
    .first();
  return Boolean(row && row.enabled);
}

module.exports = { resolveActivePlanId, hasEntitlement };
