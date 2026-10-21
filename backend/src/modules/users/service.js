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
const { writeAuthEvent, roleOutranksOrEquals } = require('../../auth');
const notifications = require('../notifications/service');
const { reserveInvitationResend } = require('../../shared/email-quota');
const { RoleEscalationError, UserRankError, SelfRoleChangeError, SelfDeactivationError, LastSuperAdminError, InvitationNotPendingError, InvitationResendLimitError } = require('./errors');
const { describeEmailDelivery } = require('../notifications/email-adapter');
const { tenantBaseUrlFor } = require('../../shared/app-domains');

const INVITATION_TTL_DAYS = 7;

function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Every user holding a role at the active property — the Setup "User management" screen's own list. */
async function listUsers({ context }) {
  const db = scopedDb().for(context);
  const users = await db
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
  // The outlets each works at here (`user_outlet_assignments`); empty = every outlet.
  const assignments = users.length
    ? await db.table('user_outlet_assignments').whereIn('user_id', users.map((user) => user.id)).select('user_id', 'outlet_id')
    : [];
  return users.map((user) => ({
    ...user,
    outlet_ids: assignments.filter((row) => String(row.user_id) === String(user.id)).map((row) => String(row.outlet_id)),
  }));
}

/** One row from `listUsers`, or null if this id holds no access at the active property — the controller's own "before" check for a real 404. */
async function getUserAtActiveProperty({ context, id }) {
  const rows = await listUsers({ context });
  return rows.find((row) => String(row.id) === String(id)) ?? null;
}

const INVITATION_LIST_COLUMNS = ['id', 'email', 'role', 'expires_at', 'accepted_at', 'revoked_at', 'invited_by_user_id', 'created_at'];

/** Strips the token hash (a credential) and adds the derived status. Used for every invitation that leaves this module. */
function publicInvitation(row) {
  if (!row) return row;
  const { token_hash: _tokenHash, ...rest } = row;
  const state = rest.accepted_at ? 'accepted' : rest.revoked_at ? 'revoked' : new Date(rest.expires_at) <= new Date() ? 'expired' : 'pending';
  return { ...rest, status: state };
}

/** Outstanding invitations at the active property: pending and expired (an expired one can be resent to renew it). Accepted and revoked ones are not listed. The token hash is never returned. */
async function listPendingInvitations({ context }) {
  const db = scopedDb().for(context);
  const rows = await db.table('user_invitations').whereNull('accepted_at').whereNull('revoked_at').orderBy('created_at', 'desc').select(...INVITATION_LIST_COLUMNS);
  return rows.map(publicInvitation);
}

function newInvitationToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
}

/**
 * Blanks the raw-token link in the email event(s) of invitations that no longer
 * work (resent, replaced or revoked), so a dead token does not linger in the
 * database and the delivery log can never re-send it.
 */
async function blankInvitationLinks(trx, invitationIds) {
  if (!invitationIds.length) return;
  const events = await trx
    .table('outbox_events')
    .where({ event_type: 'staff.invited', aggregate_type: 'user_invitations' })
    .whereIn('aggregate_id', invitationIds.map(String));
  for (const event of events) {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    if (payload?.invitationUrl) {
      await trx.table('outbox_events').where({ id: event.id }).update({ payload: JSON.stringify({ ...payload, invitationUrl: null }) });
    }
  }
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
async function inviteUser({ context, email, role, invitedByUserId, actorRole }) {
  const db = scopedDb().for(context);
  if (!roleOutranksOrEquals(actorRole, role)) throw new RoleEscalationError(role);

  const roleRow = await db.table('roles').where({ code: role, status: 'active' }).first();
  if (!roleRow) {
    throw new ValidationError('ROLE_NOT_FOUND', `"${role}" is not a valid role for this tenant.`);
  }

  return db.transaction(async (trx) => {
    // Supersede the live invitation(s) for this address. Revoked ones are kept as history.
    const superseded = await trx.table('user_invitations').where({ email }).whereNull('accepted_at').whereNull('revoked_at').select('id');
    await blankInvitationLinks(trx, superseded.map((row) => row.id));
    await trx.table('user_invitations').where({ email }).whereNull('accepted_at').whereNull('revoked_at').delete();

    const { token, tokenHash } = newInvitationToken();

    const [id] = await trx.table('user_invitations').insert({
      email,
      role,
      token_hash: tokenHash,
      expires_at: daysFromNow(INVITATION_TTL_DAYS),
      invited_by_user_id: invitedByUserId,
    });

    // Dev-only exposure outside production — the exact precedent
    // `requestPasswordResetCode` (src/auth/service.js) already established for
    // a token that would otherwise only ever leave this codebase by email.
    const devOnlyToken = process.env.NODE_ENV !== 'production' ? token : null;

    const property = await trx.table('properties').where({ id: context.propertyId }).first('name');
    const tenant = await trx.table('tenants').first('slug', 'app_domain');

    // No port here deliberately — this resolves correctly for a production
    // deployment; a local dev run of the Vite dev server still needs
    // ":5173" appended by hand, the same manual step `seeds/01_dev_tenants.js`'s
    // own printed dev-login URL already expects of a human running it.
    const invitationUrl = tenant?.slug
      ? `${tenantBaseUrlFor(tenant)}/?invite_token=${token}`
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

    // Whether the invitation email will actually reach them — a property
    // with no mailbox only writes it to the server log (user-reported), so
    // the invite screen warns instead of implying it was sent.
    const emailDelivery = await describeEmailDelivery({ db: trx, propertyId: context.propertyId });
    return { invitation: publicInvitation(await trx.table('user_invitations').where({ id }).first()), devOnlyToken, emailDelivery };
  });
}

/** Loads and locks one invitation at the active property (another property or tenant is simply not found), refusing anything accepted or revoked, and a role above the caller's own. */
async function lockActionableInvitation(trx, { id, actorRole }) {
  const invitation = await trx.table('user_invitations').where({ id }).forUpdate().first();
  if (!invitation) return null;
  if (invitation.accepted_at) throw new InvitationNotPendingError('accepted');
  if (invitation.revoked_at) throw new InvitationNotPendingError('revoked');
  if (!roleOutranksOrEquals(actorRole, invitation.role)) throw new RoleEscalationError(invitation.role);
  return invitation;
}

/**
 * Resend: a NEW token replaces the old one on the same row (the old link stops
 * working at once), the expiry restarts at the normal lifetime (so an expired
 * invitation is renewed), the old email's link is blanked, and a new email goes
 * out. The send is attempted right away and reported (`sent`, `failed` with the
 * scrubbed reason, or `queued` if the mailer takes longer than the wait limit).
 * Returns null when there is no such invitation at this property.
 */
async function resendInvitation({ context, id, actorRole }) {
  const db = scopedDb().for(context);
  const outcome = await db.transaction(async (trx) => {
    const invitation = await lockActionableInvitation(trx, { id, actorRole });
    if (!invitation) return null;
    const limited = await reserveInvitationResend({ tenantId: context.tenantId, invitationId: invitation.id });
    if (limited) throw new InvitationResendLimitError(limited);

    const { token, tokenHash } = newInvitationToken();
    await trx.table('user_invitations').where({ id }).update({ token_hash: tokenHash, expires_at: daysFromNow(INVITATION_TTL_DAYS) });
    await blankInvitationLinks(trx, [invitation.id]);

    const property = await trx.table('properties').where({ id: context.propertyId }).first('name');
    const tenant = await trx.table('tenants').first('slug', 'app_domain');
    const eventId = await writeOutboxEvent({
      trx,
      eventType: 'staff.invited',
      aggregateType: 'user_invitations',
      aggregateId: invitation.id,
      propertyId: context.propertyId,
      payload: {
        guestEmail: invitation.email,
        role: invitation.role,
        propertyName: property?.name ?? null,
        invitationUrl: tenant?.slug ? `${tenantBaseUrlFor(tenant)}/?invite_token=${token}` : null,
      },
    });
    return {
      invitation: publicInvitation(await trx.table('user_invitations').where({ id }).first()),
      eventId,
      devOnlyToken: process.env.NODE_ENV !== 'production' ? token : null,
    };
  });
  if (!outcome) return null;
  const email = await notifications.dispatchOutboxEventNow({ context, eventId: outcome.eventId });
  return { invitation: outcome.invitation, devOnlyToken: outcome.devOnlyToken, email };
}

/**
 * Delete (revoke): the invitation stays as history with `revoked_at`, and its
 * token is replaced by a hash of random bytes, so the old link is dead even for
 * a code path that forgot to check `revoked_at`. The old email's link is blanked.
 */
async function revokeInvitation({ context, id, actorRole, actorUserId }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const invitation = await lockActionableInvitation(trx, { id, actorRole });
    if (!invitation) return null;
    await trx.table('user_invitations').where({ id }).update({
      revoked_at: new Date(),
      revoked_by_user_id: actorUserId ?? null,
      token_hash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
    });
    await blankInvitationLinks(trx, [invitation.id]);
    return publicInvitation(await trx.table('user_invitations').where({ id }).first());
  });
}

const { roleRank } = require('../../auth/roles');

/**
 * The tenant-wide guard behind "the last super_admin": distinct ACTIVE users holding `super_admin` at ANY property of
 * the tenant, not counting `exceptUserId`'s super_admin rows at `exceptPropertyId` (or, with no property, any of that
 * user's rows). Called inside the transaction, after the super_admin rows are locked, so two concurrent demotions
 * cannot both see the other as the survivor.
 */
async function otherActiveSuperAdminExists(trx, { exceptUserId, exceptPropertyId }) {
  const rows = await trx.acrossProperties().table('user_property_access').where({ role: 'super_admin' }).forUpdate().select('user_id', 'property_id');
  const candidates = rows.filter((row) => !(String(row.user_id) === String(exceptUserId) && (exceptPropertyId == null || String(row.property_id) === String(exceptPropertyId))));
  const ids = [...new Set(candidates.map((row) => String(row.user_id)))];
  if (ids.length === 0) return false;
  const active = await trx.table('users').whereIn('id', ids).where({ status: 'active' }).select('id');
  return active.length > 0;
}

/** Highest rank the user holds at any property of the tenant (a super_admin elsewhere still outranks an admin here), and whether they hold `super_admin` anywhere. */
async function targetRoles(trx, id) {
  const rows = await trx.acrossProperties().table('user_property_access').where({ user_id: id }).select('role', 'property_id');
  return { roles: rows.map((row) => row.role), isSuperAdminAnywhere: rows.some((row) => row.role === 'super_admin') };
}

/** Ends every live session of the user, with the reason on the session row and a `session_revoked` auth event. Returns how many were revoked. */
async function revokeUserSessions(trx, { id, reason }) {
  return trx.table('sessions').where({ user_id: id }).whereNull('revoked_at').update({ revoked_at: new Date(), revoked_reason: reason });
}

/**
 * Immediate, and revokes every existing session — PRODUCT_REQUIREMENTS.md
 * §3.16: "Deactivation is immediate and revokes sessions." The user record
 * survives (DATABASE.md §3) — this only flips `status`, never deletes.
 *
 * Same rank rule as invite / resend / revoke (an actor may only act on someone at or below their own rank, judged by
 * the highest role the target holds at ANY property), never on yourself, and never on the tenant's last active
 * super_admin (F-01, product audit).
 */
async function deactivateUser({ context, id, actorRole, actorUserId }) {
  const db = scopedDb().for(context);
  if (actorUserId != null && String(actorUserId) === String(id)) throw new SelfDeactivationError();
  const user = await db.transaction(async (trx) => {
    const { roles, isSuperAdminAnywhere } = await targetRoles(trx, id);
    const targetRank = Math.max(0, ...roles.map(roleRank));
    if (roles.length && roleRank(actorRole) < targetRank) {
      throw new UserRankError('You cannot deactivate a user whose role ranks above your own.');
    }
    if (isSuperAdminAnywhere && !(await otherActiveSuperAdminExists(trx, { exceptUserId: id, exceptPropertyId: null }))) {
      throw new LastSuperAdminError();
    }
    await trx.table('users').where({ id }).update({ status: 'inactive' });
    await revokeUserSessions(trx, { id, reason: 'user_deactivated' });
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

/**
 * Reassigns the role held at the active property — "assign role" for an existing user. Initial role assignment
 * happens at invitation-acceptance time instead.
 *
 * F-01: the actor must outrank-or-equal BOTH the target's current role here and the new role (so an admin can neither
 * touch a super_admin nor make anyone, themselves included, a super_admin), cannot change their own role, and cannot
 * remove the tenant's last active super_admin. A real change ends the target's sessions: their old token carries no
 * role, but cached screens and long-lived refresh tokens should not outlive the privileges they were issued under.
 */
async function changeUserRole({ context, id, role, actorRole, actorUserId }) {
  const db = scopedDb().for(context);
  if (actorUserId != null && String(actorUserId) === String(id)) throw new SelfRoleChangeError();
  const roleRow = await db.table('roles').where({ code: role, status: 'active' }).first();
  if (!roleRow) {
    throw new ValidationError('ROLE_NOT_FOUND', `"${role}" is not a valid role for this tenant.`);
  }
  if (!roleOutranksOrEquals(actorRole, role)) throw new UserRankError(`You cannot assign the "${role}" role: it ranks above your own role.`);
  let changed = false;
  await db.transaction(async (trx) => {
    const current = await trx.table('user_property_access').where({ user_id: id }).forUpdate().first('role');
    if (!current) return;
    if (!roleOutranksOrEquals(actorRole, current.role)) {
      throw new UserRankError('You cannot change the role of a user whose role ranks above your own.');
    }
    if (current.role === role) return;
    if (current.role === 'super_admin' && !(await otherActiveSuperAdminExists(trx, { exceptUserId: id, exceptPropertyId: context.propertyId }))) {
      throw new LastSuperAdminError();
    }
    await trx.table('user_property_access').where({ user_id: id }).update({ role });
    await revokeUserSessions(trx, { id, reason: 'admin_revoked' });
    changed = true;
  });
  if (changed) {
    await writeAuthEvent({ audience: 'staff', eventType: 'session_revoked', tenantId: context.tenantId, propertyId: context.propertyId, userId: id });
  }
  return getUserAtActiveProperty({ context, id });
}

/**
 * Replaces the outlets a staff member works at, at the active property
 * (user-requested: "tie staff to outlets"). An empty list means every
 * outlet. Confirmed scope: this limits stock requests and their alerts only
 * (`shared/outlet-assignments.js`); manager/admin/super_admin are never
 * limited by it, whatever is saved here. Every id must be an active outlet
 * of this property — another property's or tenant's outlet is "not found".
 */
async function setUserOutlets({ context, id, outletIds }) {
  const db = scopedDb().for(context);
  const wanted = [...new Set(outletIds.map(String))];
  if (wanted.length) {
    const found = await db.table('pos_outlets').whereIn('id', wanted).where({ status: 'active' }).select('id');
    if (found.length !== wanted.length) {
      throw new ValidationError('OUTLET_NOT_FOUND', 'One of the chosen outlets does not exist or is archived.', [{ field: 'outlet_ids', issue: 'not_found' }]);
    }
  }
  await db.transaction(async (trx) => {
    await trx.table('user_outlet_assignments').where({ user_id: id }).delete();
    for (const outletId of wanted) {
      await trx.table('user_outlet_assignments').insert({ user_id: id, outlet_id: outletId });
    }
  });
  return getUserAtActiveProperty({ context, id });
}

module.exports = {
  listUsers,
  getUserAtActiveProperty,
  listPendingInvitations,
  inviteUser,
  resendInvitation,
  revokeInvitation,
  deactivateUser,
  changeUserRole,
  setUserOutlets,
};
