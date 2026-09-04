'use strict';

/**
 * Idempotency-key handling — ARCHITECTURE.md §7 (mandatory on every
 * financial mutation) and §11 (mandatory on every reservation transition:
 * "confirm this reservation retried on a flaky connection must not
 * double-book or double-charge a deposit"). No mechanism for this existed
 * anywhere in this codebase before PLAN.md Phase 2's reservations module —
 * this is that first mechanism, built as shared infra
 * (`idempotency_keys` — 20260906090000_create_idempotency_keys) so
 * Cashiering and Night Audit reuse it rather than inventing their own.
 *
 * ── THE ONE-TRANSACTION RULE ────────────────────────────────────────────
 *
 * `withIdempotency` opens exactly one database transaction per call and
 * hands the transaction-bound accessor to `handler` as its only argument.
 * `handler` must do ALL of its writes through that accessor and must not
 * open a transaction of its own — the idempotency-key row is written in the
 * SAME transaction as the handler's own state change, so a crash between
 * "reservation confirmed" and "idempotency row stored" is impossible: either
 * both commit or neither does (ARCHITECTURE.md §4's "one transaction per
 * operation", extended to cover the bookkeeping row along with the mutation
 * it is bookkeeping). This is also why `handler`'s return value is stored
 * only on success — if it throws, the whole transaction (including any
 * idempotency-key write) rolls back, so a failed attempt is never memoized
 * and a retry after a transient failure runs for real rather than replaying
 * a stale error.
 *
 * ── EXPIRY (TESTING.md IDEM-6) ───────────────────────────────────────────
 *
 * A row past its `expires_at` is treated as if it were absent: this
 * function deletes it and proceeds as a brand-new operation, rather than
 * colliding on the UNIQUE(tenant_id, operation_type, key_value) constraint.
 *
 * ── REUSE WITH DIFFERENT PARAMETERS (TESTING.md IDEM-5) ─────────────────
 *
 * An unexpired row whose stored `request_hash` does not match this
 * request's payload throws `IdempotencyKeyReuseError`
 * (409 CONFLICT_IDEMPOTENCY_KEY_REUSE) rather than either silently
 * re-processing or silently replaying the old response — ARCHITECTURE.md
 * §7's explicit rule.
 */

const crypto = require('crypto');
const { scopedDb } = require('../db');
const { AppError } = require('./errors');

const RETENTION_HOURS = 24;

class IdempotencyKeyReuseError extends AppError {
  constructor(operationType) {
    super(
      'CONFLICT_IDEMPOTENCY_KEY_REUSE',
      `This Idempotency-Key was already used for "${operationType}" with different request parameters.`,
      409,
      { operationType }
    );
  }
}

/** SHA-256 hex digest of the request payload — the material used to detect IDEM-5's "different amount/parameters" case. */
function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

/** MySQL's JSON columns may come back already-parsed (mysql2) or as a raw string, depending on driver config — handle both rather than assume one. */
function parseStoredBody(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * @param {object} params
 * @param {object} params.context  The request's scoped-db context.
 * @param {string} params.operationType  e.g. "reservations.create", "reservations.check_in".
 * @param {string} params.key  The raw `Idempotency-Key` header value.
 * @param {*} params.payload  The request body/params — hashed to detect a reused key with different material.
 * @param {(db: object) => Promise<{status: number, body: *}>} params.handler
 *   Does the actual mutation using the transaction-bound accessor it is given, and returns the response to store/replay.
 * @returns {Promise<{status: number, body: *, replayed: boolean}>}
 */
async function withIdempotency({ context, operationType, key, payload, handler }) {
  const requestHash = hashPayload(payload);
  const outerDb = scopedDb().for(context);

  return outerDb.transaction(async (trx) => {
    const now = new Date();
    const existing = await trx.table('idempotency_keys').where({ operation_type: operationType, key_value: key }).first();

    if (existing) {
      const stillValid = new Date(existing.expires_at) > now;
      if (stillValid) {
        if (existing.request_hash !== requestHash) {
          throw new IdempotencyKeyReuseError(operationType);
        }
        return { status: existing.response_status, body: parseStoredBody(existing.response_body), replayed: true };
      }
      // Expired (TESTING.md IDEM-6): treat as absent — clear it and proceed
      // as a new operation, since the UNIQUE constraint would otherwise
      // collide on the insert below.
      await trx.table('idempotency_keys').where({ id: existing.id }).delete();
    }

    const result = await handler(trx);

    const expiresAt = new Date(now.getTime() + RETENTION_HOURS * 3600 * 1000);
    await trx.table('idempotency_keys').insert({
      operation_type: operationType,
      key_value: key,
      request_hash: requestHash,
      response_status: result.status,
      response_body: JSON.stringify(result.body),
      expires_at: expiresAt,
    });

    return { status: result.status, body: result.body, replayed: false };
  });
}

module.exports = { withIdempotency, IdempotencyKeyReuseError, RETENTION_HOURS };
