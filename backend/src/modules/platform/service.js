'use strict';

/**
 * Platform console service — PLAN.md Phase 5 (Platform Foundation),
 * PRODUCT_REQUIREMENTS.md §3.22, SECURITY.md §2.
 *
 * Scope, exactly: a read-only tenant roster (`listTenants`/
 * `getTenantWithProperties`, via the scoped accessor's new
 * `platformDirectory()` entry point — the platform's own account metadata,
 * never a tenant's operational data) and the impersonation grant lifecycle
 * (`startImpersonation`/`endImpersonation`/`listImpersonationSessionsFor*`).
 * Reaching a tenant's actual data (reservations, guests, folios, ...) is
 * NOT this module's job at all — once a grant exists, every existing
 * staff-authenticated route already serves it, unmodified, via the new
 * `staff_impersonation` token audience (`src/auth/middleware.js`,
 * `src/auth/tokens.js`'s own header for the full reasoning).
 *
 * `signAccessToken` here is the ONE place an impersonation-derived token is
 * ever minted — deliberately carrying no tenant/property claim (see
 * `context.js`'s `impersonationContext`), so every subsequent request must
 * re-derive both from the live `impersonation_sessions` row.
 */

const { scopedDb } = require('../../db');
const { systemContext } = require('../tenancy');
const { signAccessToken } = require('../../auth/tokens');
const { writeAuthEvent } = require('../../auth/events');
const { SessionInvalidError } = require('../../auth/errors');
const { ValidationError } = require('../../shared/errors');
const { TenantNotFoundError, PropertyNotInTenantError } = require('./errors');

const IMPERSONATION_SESSION_MINUTES = Number(process.env.IMPERSONATION_SESSION_MINUTES || 60);

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

// ---------------------------------------------------------------------
// Tenant roster — read-only, no impersonation grant required
// ---------------------------------------------------------------------

async function listTenants({ context }) {
  const db = scopedDb().for(context);
  return db.platformDirectory().table('tenants').orderBy('name');
}

async function getTenantWithProperties({ context, tenantId }) {
  const db = scopedDb().for(context);
  const tenant = await db.platformDirectory().table('tenants').where({ id: tenantId }).first();
  if (!tenant) return null;
  const properties = await db.platformDirectory().table('properties').where({ tenant_id: tenantId }).orderBy('name');
  return { ...tenant, properties };
}

// ---------------------------------------------------------------------
// Impersonation lifecycle
// ---------------------------------------------------------------------

/**
 * @param {object} params
 * @param {object} params.context     A real platform context (`authenticate('platform')`).
 * @param {string} params.tenantId
 * @param {string} params.propertyId  Must belong to `tenantId` — verified here, not trusted from the caller.
 * @param {string} params.reason      Required — the same "money confirmations require a reason" discipline applied to this equally consequential action.
 */
async function startImpersonation({ context, tenantId, propertyId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) {
    throw new ValidationError('MISSING_FIELD', '"reason" is required to start an impersonation session.', [{ field: 'reason', issue: 'missing' }]);
  }

  return scopedDb().for(context).transaction(async (db) => {
    const user = await db.platform().table('platform_users').where({ id: context.platformUserId }).forUpdate().first();
    if (!user || user.status !== 'active') throw new SessionInvalidError();
    const tenant = await db.platformDirectory().table('tenants').where({ id: tenantId }).first();
    if (!tenant) throw new TenantNotFoundError();

    const property = await db.platformDirectory().table('properties').where({ id: propertyId, tenant_id: tenantId }).first();
    if (!property) throw new PropertyNotInTenantError();

    const expiresAt = minutesFromNow(IMPERSONATION_SESSION_MINUTES);
    const [id] = await db.platform().table('impersonation_sessions').insert({
      platform_user_id: context.platformUserId,
      tenant_id: tenantId,
      property_id: propertyId,
      reason: String(reason).trim(),
      expires_at: expiresAt,
      ip: ip ?? null,
      user_agent: userAgent ?? null,
    });

    await writeAuthEvent({
      audience: 'platform',
      eventType: 'impersonation_started',
      platformUserId: context.platformUserId,
      tenantId,
      propertyId,
      ip,
      userAgent,
      requestId,
    }, db);

    const accessToken = signAccessToken(
      { aud: 'staff_impersonation', sub: String(context.platformUserId), impersonation_session_id: String(id) },
      { expiresIn: `${IMPERSONATION_SESSION_MINUTES}m` }
    );

    return { impersonationSessionId: String(id), tenantId: String(tenantId), propertyId: String(propertyId), tenantName: tenant.name, expiresAt, accessToken };
  });
}

/**
 * `context` here is the IMPERSONATION-derived staff context itself — the
 * one function in this module called with that context rather than a real
 * platform one, since exiting is something the impersonation token itself
 * authorizes, needing no separate platform-audience call.
 */
async function endImpersonation({ context, ip, userAgent, requestId }) {
  return scopedDb().for(systemContext()).transaction(async (db) => {
    // Single-use claim, not read-then-write — the same conditional-UPDATE
    // shape every other "close this row exactly once" flow in this codebase
    // already uses. Idempotent on repeat calls: a second exit for an
    // already-ended session simply affects zero rows.
    const updated = await db
      .platform()
      .table('impersonation_sessions')
      .where({ id: context.impersonationSessionId, platform_user_id: context.platformUserId })
      .whereNull('ended_at')
      .update({ ended_at: new Date() });

    if (updated > 0) {
      await writeAuthEvent({
        audience: 'platform',
        eventType: 'impersonation_ended',
        platformUserId: context.platformUserId,
        tenantId: context.tenantId,
        propertyId: context.propertyId,
        ip,
        userAgent,
        requestId,
      }, db);
    }

    return { ended: updated > 0 };
  });
}

/** Platform-console side — every impersonation session ever run against one tenant, across every platform admin. */
async function listImpersonationSessionsForPlatform({ context, tenantId }) {
  const db = scopedDb().for(context);
  const rows = await db.platform().table('impersonation_sessions').where({ tenant_id: tenantId }).orderBy('started_at', 'desc');
  return attachPlatformUserNames(db, rows);
}

/**
 * Tenant-side "who saw my account" visibility — SECURITY.md §2's "visible
 * to the tenant," confirmed as an after-the-fact record a tenant admin can
 * look up rather than a live indicator. `context` here is an ordinary
 * STAFF context (a real tenant admin) — `tenantId` always comes from it,
 * never a caller-supplied value, so one tenant can never browse another's
 * impersonation history.
 */
async function listImpersonationSessionsForTenant({ context }) {
  const db = scopedDb().for(systemContext());
  const query = db.platform().table('impersonation_sessions').where({ tenant_id: context.tenantId });
  if (context.isImpersonation) query.where({ property_id: context.propertyId });
  const rows = await query.orderBy('started_at', 'desc');
  return attachPlatformUserNames(db, rows);
}

async function attachPlatformUserNames(db, rows) {
  if (rows.length === 0) return rows;
  const platformUserIds = [...new Set(rows.map((row) => row.platform_user_id))];
  const platformUsers = await db.platform().table('platform_users').whereIn('id', platformUserIds).select('id', 'email', 'first_name', 'last_name');
  const byId = new Map(platformUsers.map((user) => [String(user.id), user]));
  return rows.map((row) => ({ ...row, platform_user: byId.get(String(row.platform_user_id)) ?? null }));
}

module.exports = {
  listTenants,
  getTenantWithProperties,
  startImpersonation,
  endImpersonation,
  listImpersonationSessionsForPlatform,
  listImpersonationSessionsForTenant,
};
