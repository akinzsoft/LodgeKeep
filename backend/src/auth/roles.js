'use strict';

/**
 * Fresh role resolution — SECURITY.md §3–4.
 *
 * "A user's role is never global unless it is explicitly a tenant-level
 * administrative role ... Every operational role is assigned per property, in
 * user_property_access." Nothing in this file's output is ever cached in a
 * token (see `tokens.js`'s header) — every call re-reads `user_property_access`,
 * which is what makes a permission change or a property-access revocation take
 * effect on the caller's very next request rather than at the token's natural
 * expiry.
 */

/** Every property (and role at each) a user may work at, tenant-wide. */
async function listPropertyAccess(db, context, userId) {
  return db.acrossProperties().table('user_property_access').where({ user_id: userId });
}

/**
 * The role held at one specific property, or null if the user has no grant
 * there — the SECURITY.md §3 re-verification that must happen on login,
 * switch-property, and (once RBAC middleware exists) every property-scoped
 * request.
 */
async function roleAtProperty(db, context, userId, propertyId) {
  // acrossProperties() deliberately, not table(): the accessor would otherwise
  // inject the CONTEXT's own active property_id as an extra predicate, which
  // is wrong here in both directions this function is called from — during
  // login, no active property exists yet (that is what this call is
  // resolving); during switch-property, the context still carries the OLD
  // active property while `propertyId` here is the NEW one being checked, and
  // the two predicates would never agree.
  const grant = await db
    .acrossProperties()
    .table('user_property_access')
    .where({ user_id: userId, property_id: propertyId })
    .first();
  return grant ? grant.role : null;
}

/** True for the two roles PRODUCT_REQUIREMENTS.md §3.16 makes MFA mandatory for, regardless of the tenant's own MFA setting. */
function roleRequiresMfa(role) {
  return role === 'admin' || role === 'super_admin';
}

module.exports = { listPropertyAccess, roleAtProperty, roleRequiresMfa };
