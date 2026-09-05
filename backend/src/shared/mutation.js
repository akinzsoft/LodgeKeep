'use strict';

/**
 * The generic idempotent-mutation controller wrapper — originally built
 * inline in `src/modules/reservations/controller.js` (PLAN.md Phase 2);
 * promoted to shared infra in Phase 2.5 once `src/modules/cashiering/
 * controller.js` became the second module needing the identical shape, the
 * same "promoted once a second caller needs it" pattern `src/shared/
 * money.js`/`ulid.js` already followed.
 *
 * Requires an `Idempotency-Key` header (ARCHITECTURE.md §7/§11), runs
 * `handler` through `withIdempotency`, audits only a real (non-replayed)
 * execution, and fires the reactive outbox-dispatch trigger afterwards —
 * see `src/modules/reservations/controller.js`'s original header for the
 * full reasoning behind each of these, unchanged here.
 */

const { ValidationError } = require('./errors');
const { withIdempotency } = require('./idempotency');
const { enqueueOutboxDispatch } = require('../jobs/outbox-dispatcher');

function requireIdempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (!key) {
    throw new ValidationError('MISSING_IDEMPOTENCY_KEY', 'The "Idempotency-Key" header is required for this action.');
  }
  return key;
}

/**
 * @param {object} params
 * @param {string} params.operationType  e.g. "reservations.create", "cashiering.post_charge".
 * @param {string} params.entityType  `audit_log.entity_type`.
 * @param {string|number} [params.entityId]  Falls back to `result.body.data.id` when omitted (a create, where the id isn't known until the handler runs).
 * @param {string} params.action  `audit_log.action`.
 * @param {(trx: object) => Promise<{status: number, body: object}>} params.handler
 */
async function runIdempotentMutation(req, res, { operationType, entityType, entityId, action, handler }) {
  const key = requireIdempotencyKey(req);
  const result = await withIdempotency({
    context: req.context,
    operationType,
    key,
    payload: req.body,
    handler,
  });
  if (!result.replayed) {
    await req.audit({
      entityType,
      entityId: entityId ?? result.body?.data?.id ?? null,
      action,
      afterState: result.body?.data,
      reason: req.body?.reason,
    });
    // ARCHITECTURE.md §13/§14: best-effort reactive dispatch trigger, fired
    // after the transaction that wrote any outbox row has already
    // committed. A Redis outage must never fail the mutation itself — the
    // periodic sweep is the durable fallback.
    enqueueOutboxDispatch({ tenantId: req.context.tenantId, propertyId: req.context.propertyId }).catch((error) => {
      console.error('Failed to enqueue outbox dispatch (will be caught by the periodic sweep):', error);
    });
  }
  res.status(result.status).json(result.body);
}

module.exports = { runIdempotentMutation, requireIdempotencyKey };
