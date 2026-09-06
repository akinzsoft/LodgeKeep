'use strict';

/**
 * `attachAudit()` — the "usable as middleware from any module" half of
 * PLAN.md's Phase 0 audit-trail deliverable.
 *
 * Mounted once, after `authenticate('staff')` (which is what supplies
 * `req.context`), it hangs `req.audit(entry, accessorOverride?)` off the
 * request — a route handler that mutates something calls it with only the
 * domain-specific fields (`entityType`, `entityId`, `action`, `beforeState`,
 * `afterState`, and `reason` where SECURITY.md §6 calls for one); everything
 * the HTTP layer already knows (who, from where, which request) is filled in
 * here, once, so no module re-derives it.
 *
 * Non-HTTP callers — a BullMQ job, a migration, a webhook handler — have no
 * `req` at all and call `recordAuditEntry` (`service.js`) directly instead,
 * supplying `source: 'job' | 'migration' | 'integration'` themselves; this
 * file exists only for the HTTP path.
 *
 * `accessorOverride` is what makes an audit row atomic with the mutation it
 * describes: `db.for(context).transaction(async (trx) => { ...mutate...;
 * await req.audit({...}, trx); })` writes both in one transaction, so a
 * mutation can never commit with no audit row, or an audit row survive a
 * rolled-back mutation. Without it, `req.audit` uses a fresh, unscoped-to-any-
 * transaction accessor — fine for read-then-log call sites, not for anything
 * that needs the atomicity guarantee.
 */

const { scopedDb } = require('../db');
const { recordAuditEntry } = require('./service');
const { AUDIENCES } = require('../modules/tenancy');

function attachAudit() {
  return function attachAuditMiddleware(req, res, next) {
    req.audit = async (entry, accessorOverride) => {
      const context = req.context;
      const accessor = accessorOverride || scopedDb().for(context);

      // PLAN.md Phase 4 (the guest booking portal) is the first guest
      // mutation flow to exist — its own audit_log rows use the same
      // 'api' source every other machine-to-machine caller already uses
      // (SOURCES in the audit_log migration), which is what lets
      // `runIdempotentMutation` (src/shared/mutation.js) work completely
      // unmodified for a guest-audience controller: it never passes its own
      // `source`, so this default is the only thing that has to know the
      // difference. Platform's own mutation flow (impersonation) still has
      // nothing correct to default to and must pass `source` explicitly —
      // the service layer's required-field check is what catches it if it
      // doesn't.
      const defaultSource =
        context.audience === AUDIENCES.STAFF ? 'web' : context.audience === AUDIENCES.GUEST ? 'api' : undefined;

      return recordAuditEntry(accessor, {
        source: defaultSource,
        propertyId: context.propertyId,
        userId: context.userId,
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        ...entry,
      });
    };
    next();
  };
}

module.exports = { attachAudit };
