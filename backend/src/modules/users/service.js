'use strict';

/**
 * User management — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.19 ("User & staff setup: create users, assign roles, deactivate
 * leavers") and §3.16's staff invitation flow ("admin invites by email,
 * invitee sets their own password. Admins never set a password on someone's
 * behalf — it destroys attributability").
 *
 * `users`/`user_property_access`/`user_invitations`/`roles` are identity
 * tables `src/auth` already owns conceptually, but reaching them here is not
 * a module-boundary violation: the scoped accessor (not per-table module
 * ownership) is what SECURITY.md §2 makes the actual control, and every one
 * of these tables is already registered in `src/shared/table-scopes.js`.
 * What this module does NOT do is import anything from "the files behind"
 * `src/auth/index.js` (that file's own rule) — only `requirePermission`,
 * already that module's approved cross-cutting export. Accepting an
 * invitation (setting a password, becoming a real login) is the one part of
 * this flow that genuinely is auth's own business — see
 * `src/auth/service.js`'s `acceptInvitation`.
 */

const crypto = require('crypto');
const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { writeOutboxEvent } = require('../../shared/outbox');
const { writeAuthEvent } = require('../../auth');

const INVITATION_TTL_DAYS = 7;

function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Every user holding a role at the active property — the Setup "User management" screen's own list. */
async function listUsers({ context }) {
  const db = scopedDb().for(context);
  return db
    .table('user_property_access')
    .joinScoped('users', (join) => join.on('user_property_access.user_id', '=', 'users.id'))
    .select(
      'users.id as id',
      'users.email as email',
      'users.first_name as first_name',
      'users.last_name as last_name',
      'users.status as status',
      'users.last_login_at as last_login_at',
      'user_property_access.role as role'
    )
    .orderBy('users.email');
}

/** One row from `listUsers`, or null if this id holds no access at the active property — the controller's own "before" check for a real 404. */
async function getUserAtActiveProperty({ context, id }) {
  const rows = await listUsers({ context });
  return rows.find((row) => String(row.id) === String(id)) ?? null;
}

/** Outstanding invitations at the active property — `expired` is computed here rather than stored, since `expires_at` alone is the actual truth and a separate status column would be a second copy of it. */
async function listPendingInvitations({ context }) {
  const db = scopedDb().for(context);
  const rows = await db.table('user_invitations').whereNull('accepted_at').orderBy('created_at', 'desc');
  const now = new Date();
  return rows.map((row) => ({ ...row, status: new Date(row.expires_at) <= now ? 'expired' : 'pending' }));
}

/**
 * `user_invitations`' own migration header: "only one live invitation per
 * address per property is an application rule enforced by superseding the
 * outstanding row when a new invitation is issued" — the delete below is
 * that rule, not a destructive shortcut (the table is explicitly
 * hard-deletable per that same header: "credentials, not history").
 *
 * The outbox event is written inside the same transaction as the
 * invitation row (ARCHITECTURE.md §13) — `staff.invited` is a new event key
 * `src/modules/notifications/service.js`'s `EVENT_TEMPLATE_KEYS` maps to a
 * real template, the same way every other lifecycle event this codebase
 * emits already works.
 */
async function inviteUser({ context, email, role, invitedByUserId }) {
  const db = scopedDb().for(context);

  const roleRow = await db.table('roles').where({ code: role, status: 'active' }).first();
  if (!roleRow) {
    throw new ValidationError('ROLE_NOT_FOUND', `"${role}" is not a valid role for this tenant.`);
  }

  return db.transaction(async (trx) => {
    await trx.table('user_invitations').where({ email }).whereNull('accepted_at').delete();

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [id] = await trx.table('user_invitations').insert({
      email,
      role,
      token_hash: tokenHash,
      expires_at: daysFromNow(INVITATION_TTL_DAYS),
      invited_by_user_id: invitedByUserId,
    });

    // Dev-only exposure outside production — the exact precedent
    // `requestPasswordReset` (src/auth/service.js) already established for
    // a token that would otherwise only ever leave this codebase by email.
    const devOnlyToken = process.env.NODE_ENV !== 'production' ? token : null;

    const property = await trx.table('properties').where({ id: context.propertyId }).first('name');
    const tenant = await trx.table('tenants').first('slug');

    // No port here deliberately — this resolves correctly for a production
    // deployment; a local dev run of the Vite dev server still needs
    // ":5173" appended by hand, the same manual step `seeds/01_dev_tenants.js`'s
    // own printed dev-login URL already expects of a human running it.
    const invitationUrl = tenant?.slug
      ? `http://${tenant.slug}.${process.env.APP_DOMAIN}/?invite_token=${token}`
      : null;

    await writeOutboxEvent({
      trx,
      eventType: 'staff.invited',
      aggregateType: 'user_invitations',
      aggregateId: id,
      propertyId: context.propertyId,
      payload: {
        // Reuses the generic recipient-address field
        // `src/modules/notifications/service.js`'s dispatcher already keys
        // every send on (`payload.guestEmail`) — the recipient here is a
        // staff invitee, not a guest, but the dispatcher has no separate
        // "staff recipient" field, and adding one is a wider rename than
        // this invite flow needs.
        guestEmail: email,
        role,
        propertyName: property?.name ?? null,
        invitationUrl,
      },
    });

    return { invitation: await trx.table('user_invitations').where({ id }).first(), devOnlyToken };
  });
}

/**
 * Immediate, and revokes every existing session — PRODUCT_REQUIREMENTS.md
 * §3.16: "Deactivation is immediate and revokes sessions." The user record
 * survives (DATABASE.md §3) — this only flips `status`, never deletes.
 */
async function deactivateUser({ context, id }) {
  const db = scopedDb().for(context);
  const user = await db.transaction(async (trx) => {
    await trx.table('users').where({ id }).update({ status: 'inactive' });
    await trx
      .table('sessions')
      .where({ user_id: id })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), revoked_reason: 'user_deactivated' });
    return trx.table('users').where({ id }).first();
  });
  // auth_events.event_type has carried `user_deactivated` since Phase 0 —
  // see src/auth/index.js's own note on why this is written from here.
  // `userId` is the deactivated user (the event's subject, matching every
  // other auth_events row's convention) — who performed it is already the
  // actor recorded on this same request's own `audit_log` row (req.audit).
  await writeAuthEvent({
    audience: 'staff',
    eventType: 'user_deactivated',
    tenantId: context.tenantId,
    propertyId: context.propertyId,
    userId: id,
  });
  return user;
}

/** Reassigns the role held at the active property — "assign role" for an existing user. Initial role assignment happens at invitation-acceptance time instead. */
async function changeUserRole({ context, id, role }) {
  const db = scopedDb().for(context);
  const roleRow = await db.table('roles').where({ code: role, status: 'active' }).first();
  if (!roleRow) {
    throw new ValidationError('ROLE_NOT_FOUND', `"${role}" is not a valid role for this tenant.`);
  }
  await db.table('user_property_access').where({ user_id: id }).update({ role });
  return getUserAtActiveProperty({ context, id });
}

module.exports = { listUsers, getUserAtActiveProperty, listPendingInvitations, inviteUser, deactivateUser, changeUserRole };
