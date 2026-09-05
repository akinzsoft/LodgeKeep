'use strict';

/**
 * The request context — SECURITY.md §2, §3; API.md §4.
 *
 * This is the value the scoped data-access layer reads its `tenant_id` and
 * `property_id` from, and it exists as its own type for one reason:
 *
 *   "`tenant_id` comes from the authenticated session, never from the request.
 *    A `tenant_id` in a URL, body, or header is an attack, not an input."
 *                                                        — SECURITY.md §2
 *
 * A plain object passed around would make that rule a matter of discipline. A
 * frozen value with named constructors makes the provenance visible at every
 * call site: `contextFromSession(...)` is the only way a staff context is built,
 * and it reads named session fields rather than accepting a bag of properties
 * that a request body could have supplied.
 *
 * ── THREE AUDIENCES, THREE CONSTRUCTORS ──────────────────────────────────
 *
 * API.md §4 gives three identity populations three route trees, and a
 * wrong-audience token is a 401 rather than a quiet downgrade. The context
 * carries which population it came from so the accessor can refuse, for
 * instance, a guest context reaching a staff-only table — the database-level
 * half of the guarantee that AUTH-12 asserts at the HTTP level.
 *
 * ── ACTIVE PROPERTY ──────────────────────────────────────────────────────
 *
 * SECURITY.md §3: the token carries `tenant_id`, role and user id but NOT a
 * hardcoded `property_id`. The active property is session state, chosen at login
 * and changed only through an explicit switch, and "every request that touches
 * property-scoped data is verified server-side against `user_property_access`
 * for the currently active property".
 *
 * So `propertyId` here is nullable by design. A context without one is valid —
 * it simply cannot reach a PROPERTY_SCOPED table, which is exactly the failure
 * ISO-6 describes. Verifying that the user actually holds access to the property
 * is the auth layer's job and happens before a context is built; this type is
 * the carrier, not the check.
 */

const { ScopeContextError } = require('../../shared/errors');

/** The three identity populations of API.md §4. */
const AUDIENCES = Object.freeze({
  STAFF: 'staff',
  GUEST: 'guest',
  PLATFORM: 'platform',
  /**
   * Internal bookkeeping with no authenticated actor at all — the auth
   * module's own login/lockout accounting against `auth_events`, and later any
   * job that writes a PLATFORM_SCOPED infrastructure table on the system's own
   * behalf.
   *
   * Kept distinct from PLATFORM rather than folded into it: a platform context
   * names a real, audited platform_users row (SECURITY.md §2 — "never a silent
   * super-admin flag"), and a login attempt for an unknown email has no such
   * row to name. Conflating the two would mean either inventing a sentinel
   * platform user to attribute system writes to, or weakening what a platform
   * context is allowed to mean. `systemContext()` below is the only
   * constructor for this audience, and it is never built from a request.
   */
  SYSTEM: 'system',
});

/**
 * IDs arrive from MySQL as strings (`bigNumberStrings` in knexfile.js) because
 * BIGINT exceeds what a JS number can hold precisely (ARCHITECTURE.md §10).
 * Normalising every id to a string here means a context built from a JWT claim
 * (string) and one built from a row (string) compare equal, and that a caller
 * passing a number does not silently produce a context that never matches.
 */
function normalizeId(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new ScopeContextError(`${field} must be a positive integer id, received "${value}".`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  throw new ScopeContextError(`${field} must be a positive integer id, received ${typeof value}.`);
}

function freezeContext(context) {
  return Object.freeze(context);
}

/**
 * A staff context — the PMS route tree, `/api/v1/*`.
 *
 * Built from the authenticated session and nothing else. `propertyId` is the
 * active property the session currently sits on, already verified against
 * `user_property_access` by the auth layer; pass null when the session has not
 * selected one (a user with access to several properties, before they choose).
 *
 * `userId` is nullable too, for one narrow, real case: the login lookup itself.
 * By the time `resolveTenant` middleware runs, `tenant_id` is a proven fact
 * about the request (SECURITY.md §2's Host-header resolution,
 * PRODUCT_REQUIREMENTS.md §3.16) — but *which* user is logging in is exactly
 * what the `users` query this context scopes is trying to find, so there is
 * nothing to put here yet. This is not the same situation `systemContext()`
 * exists for: there, no tenant is known either, and the read goes through the
 * bootstrap path instead. Here the tenant is already certain; only the user is
 * pending. The accessor itself never reads `context.userId` — it exists on
 * the context as information for the caller, not as an input the scoping
 * guarantee depends on — so leaving it null narrows nothing the accessor
 * enforces.
 */
function contextFromSession(session) {
  if (!session || typeof session !== 'object') {
    throw new ScopeContextError('A staff context requires an authenticated session.');
  }

  const tenantId = normalizeId(session.tenantId, 'tenantId');
  if (!tenantId) {
    throw new ScopeContextError('A staff context requires a tenant_id from the session.');
  }

  return freezeContext({
    audience: AUDIENCES.STAFF,
    tenantId,
    // Nullable, unlike every other field a real staff request carries — see
    // below.
    userId: normalizeId(session.userId ?? null, 'userId'),
    // Nullable on purpose — see the note on active property above.
    propertyId: normalizeId(session.propertyId ?? null, 'propertyId'),
  });
}

/**
 * A guest context — the portal route tree, `/api/v1/portal/*`.
 *
 * A guest always has a property: the portal is a property's front door, which is
 * why `guest_accounts` is unique per (property_id, email) rather than per tenant.
 */
function guestContextFromSession(session) {
  if (!session || typeof session !== 'object') {
    throw new ScopeContextError('A guest context requires an authenticated portal session.');
  }

  const tenantId = normalizeId(session.tenantId, 'tenantId');
  const propertyId = normalizeId(session.propertyId, 'propertyId');
  if (!tenantId || !propertyId) {
    throw new ScopeContextError(
      'A guest context requires both tenant_id and property_id from the portal session.'
    );
  }

  return freezeContext({
    audience: AUDIENCES.GUEST,
    tenantId,
    propertyId,
    guestAccountId: normalizeId(session.guestAccountId ?? null, 'guestAccountId'),
  });
}

/**
 * A platform context — the platform console, `/api/v1/platform/*`.
 *
 * Deliberately has NO tenant. SECURITY.md §2: platform staff reach tenant data
 * only through an explicit, time-bounded, audited impersonation grant, "never a
 * silent super-admin flag". Until `impersonation_sessions` exists (PLAN.md
 * Phase 5), a platform context can reach PLATFORM_SCOPED tables and nothing
 * else — which is what makes AUTH-13 a 403 rather than a quiet read.
 */
function platformContext({ platformUserId }) {
  const id = normalizeId(platformUserId, 'platformUserId');
  if (!id) {
    throw new ScopeContextError('A platform context requires a platform_user id.');
  }

  return freezeContext({
    audience: AUDIENCES.PLATFORM,
    platformUserId: id,
    // Named explicitly rather than omitted, so that reading `ctx.tenantId` and
    // getting `null` is an obvious "no tenant" rather than a typo returning
    // undefined.
    tenantId: null,
    propertyId: null,
  });
}

/**
 * Narrows a context to a specific active property.
 *
 * Returns a new frozen context rather than mutating: a request handler that
 * scoped down to one property must not be able to change what its caller sees.
 * The property must already be one the user is entitled to — this function
 * carries the choice, it does not authorize it.
 */
function withActiveProperty(context, propertyId) {
  if (context.audience === AUDIENCES.PLATFORM) {
    throw new ScopeContextError(
      'A platform context has no tenant, so it cannot take an active property. ' +
        'Tenant data is reached only through an audited impersonation grant (SECURITY.md §2).'
    );
  }

  return freezeContext({ ...context, propertyId: normalizeId(propertyId, 'propertyId') });
}

/**
 * The system context — internal bookkeeping, not a person.
 *
 * No ids at all: there is nothing to identify, which is exactly the case a
 * login attempt for an unknown email is in. This is the one context type never
 * built from a request — it is wired directly into the auth module's own
 * service code, never derived from a token or session.
 */
function systemContext() {
  return freezeContext({
    audience: AUDIENCES.SYSTEM,
    tenantId: null,
    propertyId: null,
  });
}

/**
 * A background-job context — PLAN.md Phase 3's outbox dispatcher
 * (`src/jobs/outbox-dispatcher.js`), ARCHITECTURE.md §14: "every job carries
 * `tenant_id`" in its own payload, not derived from a request. Unlike
 * `systemContext()`, this DOES carry a real tenant/property — the whole
 * reason a job needs one at all is to write to TENANT_SCOPED/PROPERTY_SCOPED
 * tables (`notification_log`, `in_app_notifications`, ...) on no human's
 * behalf, which `systemContext()`'s always-null ids cannot reach
 * (`scopeRequirements` in `scoped-db.js` requires a real `tenantId` for
 * either scope). Still SYSTEM audience, not STAFF: there is no session, no
 * authenticated user, and no active-property verification against
 * `user_property_access` to have performed — the ids come from the outbox
 * event row itself (already a committed, trusted fact, not request input),
 * never from an external caller, so SECURITY.md §2's "tenant_id never comes
 * from the request" is not in tension with this constructor.
 */
function workerContext({ tenantId, propertyId }) {
  const normalizedTenantId = normalizeId(tenantId, 'tenantId');
  if (!normalizedTenantId) {
    throw new ScopeContextError('A worker context requires a tenant_id from the job payload.');
  }
  return freezeContext({
    audience: AUDIENCES.SYSTEM,
    tenantId: normalizedTenantId,
    propertyId: normalizeId(propertyId ?? null, 'propertyId'),
  });
}

module.exports = {
  AUDIENCES,
  contextFromSession,
  guestContextFromSession,
  platformContext,
  systemContext,
  workerContext,
  withActiveProperty,
};
