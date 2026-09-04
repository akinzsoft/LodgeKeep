'use strict';

/**
 * The audit trail's core write path — SECURITY.md §6.
 *
 * One function, callable from anywhere a mutation happens: an HTTP route
 * (through `middleware.js`'s convenience wrapper), a BullMQ job, a migration,
 * or an integration/webhook handler. All of them end up here so the row shape
 * is defined in exactly one place.
 */

const { ValidationError } = require('../shared/errors');

const REQUIRED_FIELDS = ['entityType', 'action', 'source'];

/**
 * @param {object} scopedAccessor  The caller's own `db.for(context)` (or the
 *   transaction-bound accessor from inside `.transaction(cb)`) — never built
 *   here, so a caller that wants the audit row to commit atomically with the
 *   mutation it describes just passes the same accessor it mutated with.
 * @param {object} entry
 * @param {string} entry.entityType    e.g. "reservations" — the table the row describes
 * @param {string|number|null} [entry.entityId]
 * @param {string} entry.action        e.g. "create", "void", "check_in" — API.md §5's one-to-one with an endpoint
 * @param {string} entry.source        'web'|'api'|'job'|'migration'|'platform_impersonation'|'integration'
 * @param {string|number|null} [entry.propertyId]  Attribution, not scope — see table-scopes.js
 * @param {string|number|null} [entry.userId]      NULL for a job/migration source
 * @param {*} [entry.beforeState]       Any JSON-serializable value; NULL on create
 * @param {*} [entry.afterState]        Any JSON-serializable value; NULL on a genuine hard delete
 * @param {string} [entry.reason]       Required by convention for voids/refunds/overrides (SECURITY.md §6) — not enforced here, since which actions need a reason is a per-module rule, not a schema-wide one
 * @param {string} [entry.requestId]
 * @param {string} [entry.ipAddress]
 * @param {string} [entry.userAgent]
 */
async function recordAuditEntry(scopedAccessor, entry) {
  const missing = REQUIRED_FIELDS.filter((field) => !entry[field]);
  if (missing.length) {
    throw new ValidationError(
      'AUDIT_ENTRY_INCOMPLETE',
      `Audit entry missing required field(s): ${missing.join(', ')}.`,
      missing.map((field) => ({ field, issue: 'missing' }))
    );
  }

  return scopedAccessor.table('audit_log').insert({
    property_id: entry.propertyId ?? null,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    action: entry.action,
    user_id: entry.userId ?? null,
    before_state: entry.beforeState ?? null,
    after_state: entry.afterState ?? null,
    request_id: entry.requestId ?? null,
    ip_address: entry.ipAddress ?? null,
    user_agent: entry.userAgent ?? null,
    source: entry.source,
    reason: entry.reason ?? null,
  });
}

module.exports = { recordAuditEntry };
