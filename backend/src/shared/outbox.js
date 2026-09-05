'use strict';

/**
 * The outbox write side — ARCHITECTURE.md §13, PLAN.md Phase 3's
 * Notifications module. The read/dispatch side lives in
 * `src/jobs/outbox-dispatcher.js`; this file is only ever called from
 * inside a business transaction that is ALSO writing the state change the
 * event describes, mirroring `src/shared/idempotency.js`'s "one transaction,
 * both writes" shape.
 *
 * `writeOutboxEvent` takes `trx` — an already transaction-bound scoped
 * accessor — never opens its own transaction, exactly like every
 * `{ trx }`-taking function in `src/modules/reservations/service.js`. A
 * caller that wrote it outside a transaction has broken the one guarantee
 * this pattern exists for: that the event row commits atomically with the
 * change it describes, never one without the other.
 */

/**
 * @param {object} params
 * @param {object} params.trx  A transaction-bound scoped accessor.
 * @param {string} params.eventType  e.g. "reservation.confirmed" (ARCHITECTURE.md §13's dotted vocabulary).
 * @param {string} params.aggregateType  e.g. "reservations".
 * @param {string|number} params.aggregateId
 * @param {object} params.payload  Enough detail for the dispatcher to act without re-querying (ARCHITECTURE.md §13).
 * @param {string|number} [params.propertyId]  Attribution, not scope — see `outbox_events`' own table-scopes.js entry.
 */
async function writeOutboxEvent({ trx, eventType, aggregateType, aggregateId, payload, propertyId }) {
  const [id] = await trx.table('outbox_events').insert({
    property_id: propertyId ?? null,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload: JSON.stringify(payload ?? {}),
    status: 'pending',
  });
  return id;
}

module.exports = { writeOutboxEvent };
