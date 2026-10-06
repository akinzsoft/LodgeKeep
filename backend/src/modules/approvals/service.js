'use strict';

/**
 * Manager approvals — re-authentication at the moment of a sensitive action
 * (security fix, release-blocking). Before this, settlement voids, refunds
 * and stock overrides were gated only by the logged-in `pos.manage` /
 * `supermarket.manage` permission, so a shared or unattended manager session
 * approved them silently.
 *
 * The flow:
 *   1. A manager sets a 6-digit approval PIN (`setApprovalPin`, after
 *      re-entering their password). It is never a login credential.
 *   2. At the till, someone picks the approving manager by name and the
 *      manager types their PIN (`requestApproval`). The server checks the PIN
 *      and that the manager holds the action's permission AT THIS PROPERTY
 *      now, and returns an opaque token: single use, 2 minutes, bound to the
 *      action, the record and the person at the till.
 *   3. The action sends that token in the `X-Manager-Approval` header (never
 *      the body, so idempotency payloads and request bodies are unchanged)
 *      and calls `consumeApproval` inside its own transaction: one
 *      conditional UPDATE claims it. A rolled-back action leaves it unused;
 *      two requests carrying it can never both succeed.
 *
 * Wrong PINs are counted on the PIN row under a row lock (simultaneous
 * guesses cannot slip past the count); 5 within 15 minutes lock that
 * manager's PIN for 15 minutes and bell the managers. Login lockout is not
 * affected.
 *
 * Who approved is recorded on the approval row and in its own audit_log rows
 * (entity_type `manager_approvals`). The gated action's own audit row is
 * deliberately untouched: the hotel payment golden suite snapshots it.
 */

const crypto = require('crypto');
const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { recordAuditEntry } = require('../../audit/service');
const { hashPassword, verifyPassword } = require('../../auth/password');
const { writeAuthEvent } = require('../../auth/events');
const { roleAtProperty } = require('../../auth/roles');
const { hasPermission } = require('../../auth/rbac');
const { notifyStaff } = require('../notifications/staff-notifications');
const { approvalAction } = require('./registry');
const errors = require('./errors');

const APPROVAL_TTL_MS = 2 * 60_000;
const PIN_FAILURE_LIMIT = 5;
const PIN_FAILURE_WINDOW_MS = 15 * 60_000;
const PIN_LOCK_MS = 15 * 60_000;
const PIN_PATTERN = /^\d{6}$/;
const MAX_REASON_LENGTH = 500;
const APPROVAL_HEADER = 'X-Manager-Approval';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** True for a PIN anyone would try first: one digit repeated, or a straight run up or down (123456, 654321). */
function isTrivialPin(pin) {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((digit, index) => digit - digits[index]));
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}

function assertPinFormat(pin) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) {
    throw new ValidationError('APPROVAL_PIN_FORMAT', 'The PIN must be exactly 6 digits.', [{ field: 'pin', issue: 'invalid' }]);
  }
}

/** Request metadata as the audit_log row's own fields. */
function auditMeta(meta) {
  return { requestId: meta.requestId ?? null, ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null };
}

const loadUser = (db, id) => db.table('users').where({ id }).first('id', 'first_name', 'last_name', 'email');

function requireAction(action) {
  const definition = approvalAction(action);
  if (!definition) throw new ValidationError('UNKNOWN_APPROVAL_ACTION', `"${action}" is not an action that takes a manager approval.`, [{ field: 'action', issue: 'unknown' }]);
  return definition;
}

function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
}

/** Whether `userId` is an active user who holds `permission` at the context's active property, read fresh. */
async function mayApprove(db, context, userId, permission) {
  const user = await db.table('users').where({ id: userId, status: 'active' }).first('id');
  if (!user) return false;
  const role = await roleAtProperty(db, context, userId, context.propertyId);
  return Boolean(role) && hasPermission(db, role, permission);
}

/**
 * The people who may approve `action` here, by name, with whether each has
 * set a PIN — so the dialog can say "Grace has not set a PIN" instead of
 * offering a choice that cannot work. Ids and names only.
 */
async function listApprovers(context, action) {
  const definition = requireAction(action);
  const db = scopedDb().for(context);
  const rows = await db
    .table('user_property_access')
    .joinScoped('users', (join) => join.on('user_property_access.user_id', '=', 'users.id'))
    .where({ 'users.status': 'active' })
    .select('users.id', 'users.first_name', 'users.last_name', 'users.email', 'user_property_access.role');

  const roleAllowed = new Map();
  const eligible = [];
  for (const row of rows) {
    if (!roleAllowed.has(row.role)) roleAllowed.set(row.role, await hasPermission(db, row.role, definition.permission));
    if (roleAllowed.get(row.role)) eligible.push(row);
  }
  const pins = eligible.length
    ? await db.table('approval_pins').whereIn('user_id', eligible.map((row) => row.id)).select('user_id')
    : [];
  const withPin = new Set(pins.map((row) => String(row.user_id)));
  return eligible
    .map((row) => ({ id: String(row.id), name: displayName(row), hasPin: withPin.has(String(row.id)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function cleanReason(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw new ValidationError('MISSING_FIELD', '"reason" is required for a manager approval.', [{ field: 'reason', issue: 'missing' }]);
  if (text.length > MAX_REASON_LENGTH) throw new ValidationError('REASON_TOO_LONG', `The reason may be at most ${MAX_REASON_LENGTH} characters.`, [{ field: 'reason', issue: 'too_long' }]);
  return text;
}

function cleanTargetId(definition, targetId) {
  if (targetId === undefined || targetId === null || targetId === '') {
    if (definition.targetRequired) throw new ValidationError('MISSING_FIELD', '"target_id" is required for this approval.', [{ field: 'target_id', issue: 'missing' }]);
    return null;
  }
  if (!/^\d+$/.test(String(targetId))) throw new ValidationError('INVALID_TARGET', '"target_id" must be a record id.', [{ field: 'target_id', issue: 'invalid' }]);
  if (!definition.targetType) throw new ValidationError('INVALID_TARGET', 'This approval is not for a specific record.', [{ field: 'target_id', issue: 'unexpected' }]);
  return String(targetId);
}

/**
 * Checks the manager's PIN and, if right, issues a single-use approval for
 * `action` on `targetId`, usable only by the person at the till (`context`).
 * A wrong PIN is counted (committed even though the request then fails); the
 * fifth within 15 minutes locks the PIN and bells the managers.
 *
 * @returns {Promise<{token: string, expiresAt: Date, approvalId: string, approver: {id: string, name: string}}>}
 */
async function requestApproval(context, { action, approverUserId, pin, reason, targetId, meta = {} }) {
  const definition = requireAction(action);
  const text = cleanReason(reason);
  const target = cleanTargetId(definition, targetId);
  if (!approverUserId || !/^\d+$/.test(String(approverUserId))) {
    throw new ValidationError('MISSING_FIELD', '"approver_user_id" is required.', [{ field: 'approver_user_id', issue: 'missing' }]);
  }
  assertPinFormat(pin);

  const db = scopedDb().for(context);
  if (!(await mayApprove(db, context, approverUserId, definition.permission))) throw new errors.ApproverNotEligibleError(action);

  const outcome = await db.transaction(async (trx) => {
    const now = new Date();
    const pinRow = await trx.table('approval_pins').where({ user_id: approverUserId }).forUpdate().first();
    if (!pinRow) return { kind: 'not_set' };
    if (pinRow.locked_until && new Date(pinRow.locked_until) > now) return { kind: 'locked', lockedUntil: pinRow.locked_until };

    if (!(await verifyPassword(pin, pinRow.pin_hash))) {
      const windowOpen = pinRow.failure_window_started_at && now - new Date(pinRow.failure_window_started_at) < PIN_FAILURE_WINDOW_MS;
      const failures = (windowOpen ? pinRow.failed_count : 0) + 1;
      if (failures >= PIN_FAILURE_LIMIT) {
        const lockedUntil = new Date(now.getTime() + PIN_LOCK_MS);
        await trx.table('approval_pins').where({ id: pinRow.id }).update({ failed_count: 0, failure_window_started_at: null, locked_until: lockedUntil });
        return { kind: 'locked_now', lockedUntil };
      }
      await trx
        .table('approval_pins')
        .where({ id: pinRow.id })
        .update({ failed_count: failures, failure_window_started_at: windowOpen ? pinRow.failure_window_started_at : now });
      return { kind: 'wrong', attemptsLeft: PIN_FAILURE_LIMIT - failures };
    }

    if (pinRow.failed_count > 0 || pinRow.locked_until) {
      await trx.table('approval_pins').where({ id: pinRow.id }).update({ failed_count: 0, failure_window_started_at: null, locked_until: null });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
    const [approvalId] = await trx.table('manager_approvals').insert({
      token_hash: hashToken(token),
      action,
      target_type: target ? definition.targetType : null,
      target_id: target,
      requested_by_user_id: context.userId,
      approver_user_id: approverUserId,
      reason: text,
      expires_at: expiresAt,
    });
    await recordAuditEntry(trx, {
      entityType: 'manager_approvals',
      entityId: approvalId,
      propertyId: context.propertyId,
      userId: approverUserId,
      action: 'approval_issued',
      source: 'web',
      afterState: { action, target_type: target ? definition.targetType : null, target_id: target, requested_by_user_id: String(context.userId), approver_user_id: String(approverUserId) },
      reason: text,
      ...auditMeta(meta),
    });
    const approver = await loadUser(trx, approverUserId);
    return { kind: 'issued', token, expiresAt, approvalId: String(approvalId), approver: { id: String(approver.id), name: displayName(approver) } };
  });

  const eventBase = { audience: 'staff', tenantId: context.tenantId, propertyId: context.propertyId, userId: approverUserId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId };
  switch (outcome.kind) {
    case 'not_set':
      throw new errors.ApprovalPinNotSetError();
    case 'locked':
      throw new errors.ApprovalPinLockedError(outcome.lockedUntil);
    case 'wrong':
      await writeAuthEvent({ ...eventBase, eventType: 'approval_pin_failed' });
      throw new errors.ApprovalPinIncorrectError(outcome.attemptsLeft);
    case 'locked_now':
      await writeAuthEvent({ ...eventBase, eventType: 'approval_pin_failed' });
      await writeAuthEvent({ ...eventBase, eventType: 'approval_pin_locked' });
      // The lock is already committed; a failing bell must not turn the answer into a 500.
      await alertPinLocked(context, approverUserId, action, meta).catch((error) => console.error('Could not bell the managers about a locked approval PIN:', error));
      throw new errors.ApprovalPinLockedError(outcome.lockedUntil);
    default:
      return { token: outcome.token, expiresAt: outcome.expiresAt, approvalId: outcome.approvalId, approver: outcome.approver };
  }
}

/** Someone just locked a manager's PIN by guessing at a till: tell the managers, and leave an audit row. */
async function alertPinLocked(context, approverUserId, action, meta) {
  const db = scopedDb().for(context);
  await db.transaction(async (trx) => {
    // Sequential, never Promise.all on one transaction (it can hang knex).
    const approver = await loadUser(trx, approverUserId);
    const requester = await loadUser(trx, context.userId);
    await recordAuditEntry(trx, {
      entityType: 'approval_pins',
      entityId: null,
      propertyId: context.propertyId,
      userId: context.userId,
      action: 'approval_pin_locked',
      source: 'web',
      afterState: { approver_user_id: String(approverUserId), action },
      ...auditMeta(meta),
    });
    await notifyStaff({
      trx,
      eventType: 'approvals.pin_locked',
      payload: {
        approverUserId: String(approverUserId),
        approverName: approver ? displayName(approver) : null,
        triedByName: requester ? displayName(requester) : null,
        action,
        actionLabel: approvalAction(action)?.label ?? action,
      },
    });
  });
}

/**
 * Claims the approval carried by the request, inside the caller's own
 * transaction, as the first thing the gated action does. Throws
 * `ManagerApprovalRequiredError` (403) without a token and
 * `ApprovalInvalidError` (422) for one that does not match — unknown, used,
 * expired, another action, record, property or person, or an approver who no
 * longer holds the permission. On success writes the `approval_used` audit
 * row (same transaction) and returns who approved and why.
 *
 * @param {object} trx  The action's transaction accessor (scoped to the request's context).
 * @returns {Promise<{approvalId: string, approverUserId: string, reason: string}>}
 */
async function consumeApproval(trx, { context, token, action, targetId = null, meta = {} }) {
  const definition = requireAction(action);
  if (!token) throw new errors.ManagerApprovalRequiredError(action);

  const tokenHash = hashToken(String(token));
  const query = trx
    .table('manager_approvals')
    .where({ token_hash: tokenHash, action, requested_by_user_id: context.userId })
    .whereNull('used_at')
    .where('expires_at', '>', new Date());
  if (definition.targetRequired) query.where({ target_id: String(targetId ?? '') });
  else query.whereNull('target_id');
  const claimed = await query.update({ used_at: new Date() });
  if (claimed !== 1) throw new errors.ApprovalInvalidError(action);

  const approval = await trx.table('manager_approvals').where({ token_hash: tokenHash }).first();
  // The approver's own standing is re-read now: a manager demoted or
  // deactivated after typing their PIN no longer approves anything. The throw
  // rolls the claim back with the rest of the action.
  if (!(await mayApprove(trx, context, approval.approver_user_id, definition.permission))) throw new errors.ApprovalInvalidError(action);

  await recordAuditEntry(trx, {
    entityType: 'manager_approvals',
    entityId: approval.id,
    propertyId: context.propertyId,
    userId: approval.approver_user_id,
    action: 'approval_used',
    source: 'web',
    afterState: {
      action,
      target_type: approval.target_type,
      target_id: approval.target_id === null ? null : String(approval.target_id),
      requested_by_user_id: String(approval.requested_by_user_id),
      approver_user_id: String(approval.approver_user_id),
    },
    reason: approval.reason,
    ...auditMeta(meta),
  });
  return { approvalId: String(approval.id), approverUserId: String(approval.approver_user_id), reason: approval.reason };
}

/** The approval token a request carries (`X-Manager-Approval`), or null. */
function readApprovalToken(req) {
  const value = req.get(APPROVAL_HEADER);
  return value ? value.trim() : null;
}

/** Request metadata for the audit and auth-event rows. */
function requestMeta(req) {
  return { requestId: req.requestId ?? null, ip: req.ip ?? null, userAgent: req.get('User-Agent') ?? null };
}

/**
 * Claims the request's approval for `action` on `targetId` inside `trx` — the
 * call a controller makes as the first statement of its own transaction.
 */
function claimApproval(req, trx, action, targetId = null) {
  return consumeApproval(trx, { context: req.context, token: readApprovalToken(req), action, targetId, meta: requestMeta(req) });
}

/**
 * The same claim as an `approve(trx)` hook, for a service that opens the
 * transaction itself (and claims only when the gated thing actually applies:
 * an oversell, a stock override, a POS-payment refund).
 */
function approvalConsumer(req, action, targetId = null) {
  return (trx) => claimApproval(req, trx, action, targetId);
}

/** Whether the signed-in user has set an approval PIN. */
async function getMyApprovalPin(context) {
  const db = scopedDb().for(context);
  const row = await db.table('approval_pins').where({ user_id: context.userId }).first('set_at', 'locked_until');
  return { hasPin: Boolean(row), setAt: row?.set_at ?? null, lockedUntil: row?.locked_until && new Date(row.locked_until) > new Date() ? row.locked_until : null };
}

/**
 * Sets or changes the signed-in user's approval PIN after re-checking their
 * password. A new PIN also clears a lock: the lock stops someone guessing,
 * and the owner proving their password is not guessing.
 */
async function setApprovalPin(context, { currentPassword, pin, meta = {} }) {
  assertPinFormat(pin);
  if (isTrivialPin(pin)) {
    throw new ValidationError('APPROVAL_PIN_TOO_SIMPLE', 'Choose a PIN that is not one digit repeated or a straight run like 123456.', [{ field: 'pin', issue: 'too_simple' }]);
  }
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw new ValidationError('MISSING_FIELD', '"current_password" is required.', [{ field: 'current_password', issue: 'missing' }]);
  }
  const db = scopedDb().for(context);
  const user = await db.table('users').where({ id: context.userId }).first('id', 'password_hash');
  const eventBase = { audience: 'staff', eventType: 'approval_pin_set', tenantId: context.tenantId, propertyId: context.propertyId ?? null, userId: context.userId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId };
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    await writeAuthEvent({ ...eventBase, failureReason: 'invalid_password' });
    throw new ValidationError('CURRENT_PASSWORD_INCORRECT', 'Current password is incorrect.');
  }

  const pinHash = await hashPassword(pin);
  const now = new Date();
  await db.transaction(async (trx) => {
    const existing = await trx.table('approval_pins').where({ user_id: context.userId }).forUpdate().first('id');
    const fields = { pin_hash: pinHash, set_at: now, failed_count: 0, failure_window_started_at: null, locked_until: null };
    if (existing) await trx.table('approval_pins').where({ id: existing.id }).update(fields);
    else await trx.table('approval_pins').insert({ user_id: context.userId, ...fields });
    // The PIN itself, and its hash, never enter the audit log.
    await recordAuditEntry(trx, {
      entityType: 'approval_pins',
      entityId: null,
      propertyId: context.propertyId ?? null,
      userId: context.userId,
      action: existing ? 'approval_pin_changed' : 'approval_pin_set',
      source: 'web',
      ...auditMeta(meta),
    });
  });
  await writeAuthEvent(eventBase);
  return { hasPin: true, setAt: now };
}

module.exports = {
  APPROVAL_HEADER,
  APPROVAL_TTL_MS,
  PIN_FAILURE_LIMIT,
  isTrivialPin,
  listApprovers,
  requestApproval,
  consumeApproval,
  claimApproval,
  approvalConsumer,
  readApprovalToken,
  requestMeta,
  getMyApprovalPin,
  setApprovalPin,
};
