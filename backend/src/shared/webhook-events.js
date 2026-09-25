'use strict';

/**
 * Durable persistence and processing state for gateway webhook events
 * (`payment_webhook_events`, `subscription_webhook_events`) — ARCHITECTURE.md
 * §7 / API.md §7: verified, persisted before processing, deduplicated,
 * processed idempotently, answered `200` once persisted.
 *
 * Shared by the guest-payment and billing webhook handlers so the two can
 * never drift on the rules that matter:
 *
 * 1. UNSIGNED REQUESTS NEVER BLOCK SIGNED ONES. An unauthenticated caller can
 *    post `{data: {id: N}}` with a bad signature before Paystack's genuine
 *    event with that id arrives. The unsigned row is kept (a forged event is
 *    evidence, and tests require it) but a later SIGNED event with the same id
 *    UPGRADES the row and is processed, instead of being deduplicated away.
 *
 * 2. A PERSISTED EVENT IS NEVER STRANDED. A redelivery of a signed event that
 *    was persisted but never finalized (`outcome IS NULL`) is processed again
 *    rather than dropped; and every signed event is scheduled
 *    (`next_attempt_at`) so the retry sweep (`src/jobs/payment-webhooks.js`)
 *    picks it up even if Paystack never redelivers.
 *
 * 3. DEDUPLICATION IS ATOMIC. Insert-and-catch on the UNIQUE key, never
 *    check-then-insert, so two concurrent deliveries cannot 500.
 *
 * Attribution (`tenant_id`, `property_id`, `related_*_id`) is written ONLY for
 * signed events: an unauthenticated caller chooses the reference, so nothing it
 * names may be attributed to a tenant.
 */

/** How long a freshly-persisted signed event is left to its inline attempt before the sweep may pick it up. */
const FIRST_ATTEMPT_GRACE_MS = 120_000;

/** Give up after this many failed processing attempts (about 4 hours with the backoff below). */
const MAX_ATTEMPTS = 12;

/**
 * A Paystack 404 for a reference we hold a payment for is not decided on the
 * first look: it can be read-after-write lag right after the webhook, or a key
 * rotated since the payment was created. The first few are deferred (about 7
 * minutes with the backoff below); only a persistent 404 is rejected.
 */
const RECORD_NOT_FOUND_GRACE_ATTEMPTS = 3;

/** Only these events are keyed by the bare provider id; see `webhookEventKey`. */
const CHARGE_EVENT_TYPES = new Set(['charge.success', 'charge.failed']);

/**
 * The dedup key for an event. Charge events keep the bare transaction id
 * (unchanged, so existing rows still dedupe). Every OTHER event type is
 * namespaced, because its numeric `data.id` (a refund id, a dispute id) is not
 * a transaction id and can collide with one — a signed non-charge event must
 * never claim the key a genuine `charge.success` needs.
 */
function webhookEventKey({ event, id, fallback }) {
  if (id == null || id === '') return fallback;
  return CHARGE_EVENT_TYPES.has(event) ? String(id) : `${event ?? 'unknown'}:${id}`;
}

/** Backoff after the Nth failed attempt: 1, 2, 4, 8, 16, then capped at 30 minutes. */
function backoffMinutes(attemptCount) {
  return Math.min(2 ** Math.max(0, attemptCount - 1), 30);
}

/**
 * @param {object} args
 * @param {() => object} args.events  returns a FRESH table builder for the event table each call
 * @param {string} args.provider
 * @param {string} args.providerEventId
 * @param {object} args.payload
 * @param {boolean} args.verified
 * @param {object} [args.attribution]  columns to set for a signed event only (tenant_id, property_id, related_*_id)
 * @param {Date} [args.now]
 * @returns {Promise<{id: number|string, created: boolean, upgraded: boolean, deduplicated: boolean, needsProcessing: boolean, attemptCount: number}>}
 */
async function persistWebhookEvent({ events, provider, providerEventId, payload, verified, attribution = {}, now = new Date() }) {
  const signed = Boolean(verified);
  const schedule = () => new Date(now.getTime() + FIRST_ATTEMPT_GRACE_MS);
  const body = JSON.stringify(payload ?? {});

  try {
    const [id] = await events().insert({
      provider,
      provider_event_id: providerEventId,
      payload: body,
      verified: signed,
      ...(signed ? { ...attribution, next_attempt_at: schedule() } : {}),
    });
    return { id, created: true, upgraded: false, deduplicated: false, needsProcessing: signed, attemptCount: 0 };
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
  }

  let existing = await events().where({ provider, provider_event_id: providerEventId }).first();
  if (!existing) {
    // The winner of the race was rolled back between our insert and this read —
    // treat it as never having existed and let the caller's retry win.
    throw Object.assign(new Error('webhook event vanished between duplicate-key and re-read'), { code: 'WEBHOOK_EVENT_RACE' });
  }

  if (!signed) {
    // Nothing an unsigned request says may change or block anything.
    return { id: existing.id, created: false, upgraded: false, deduplicated: true, needsProcessing: false, attemptCount: existing.attempt_count };
  }

  if (!existing.verified) {
    // A genuine, signed event arriving after an unsigned one squatted its id.
    const upgraded = await events()
      .where({ id: existing.id, verified: 0 })
      .update({ verified: true, payload: body, ...attribution, next_attempt_at: schedule() });
    if (upgraded === 1) {
      return { id: existing.id, created: false, upgraded: true, deduplicated: false, needsProcessing: true, attemptCount: 0 };
    }
    existing = await events().where({ id: existing.id }).first(); // lost a race to another signed delivery; fall through
  }

  if (existing.outcome == null) {
    // Signed, persisted, but never finalized: a stranded (or concurrently in-flight) event. Process it again.
    return { id: existing.id, created: false, upgraded: false, deduplicated: false, needsProcessing: true, attemptCount: existing.attempt_count };
  }
  return { id: existing.id, created: false, upgraded: false, deduplicated: true, needsProcessing: false, attemptCount: existing.attempt_count };
}

/**
 * Records a TERMINAL decision. Conditional on `outcome IS NULL`, so two
 * processors racing on one event cannot overwrite each other's decision.
 * Returns true when this call recorded the decision.
 */
async function finalizeWebhookEvent({ events, id, outcome, detail = null, attribution = {}, now = new Date() }) {
  const updated = await events()
    .where({ id })
    .whereNull('outcome')
    .update({
      outcome,
      outcome_detail: detail == null ? null : JSON.stringify(detail),
      processed_at: now,
      last_attempt_at: now,
      next_attempt_at: null,
      ...attribution,
    });
  return updated === 1;
}

/**
 * Records a failed / not-yet-final attempt and schedules the next one — or
 * gives up (`deferred_exhausted`) after `MAX_ATTEMPTS`. Returns the outcome
 * recorded, `null` for "deferred, will retry", or `'deferred_exhausted'`.
 */
async function deferWebhookEvent({ events, id, attemptCount, reason, now = new Date() }) {
  const attempts = attemptCount + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await finalizeWebhookEvent({ events, id, outcome: 'deferred_exhausted', detail: { attempts, lastReason: reason }, now });
    return 'deferred_exhausted';
  }
  await events()
    .where({ id })
    .whereNull('outcome')
    .update({
      attempt_count: attempts,
      last_attempt_at: now,
      next_attempt_at: new Date(now.getTime() + backoffMinutes(attempts) * 60_000),
      outcome_detail: JSON.stringify({ attempts, lastReason: reason }),
    });
  return null;
}

module.exports = {
  persistWebhookEvent,
  finalizeWebhookEvent,
  deferWebhookEvent,
  backoffMinutes,
  webhookEventKey,
  RECORD_NOT_FOUND_GRACE_ATTEMPTS,
  FIRST_ATTEMPT_GRACE_MS,
  MAX_ATTEMPTS,
};
