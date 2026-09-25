'use strict';

/**
 * Processing state for `payment_webhook_events` and `subscription_webhook_events`
 * — the durable record of "what happened to this event", so a persisted event
 * can never again be silently stranded.
 *
 * Until now both tables were write-once: an event was persisted, then processed
 * inline, and `processed_at` was the only trace. If processing threw after the
 * event was persisted, the controller returned 5xx, Paystack retried, the
 * retry hit the `UNIQUE(provider, provider_event_id)` dedup and was answered
 * 200 without being processed — the event was lost for good, and nothing else
 * ever read these tables. (For subscription billing that is worse: an invoice
 * with an INITIATED/PENDING payment is skipped by the renewal sweep, so the
 * webhook is the ONLY thing that can resolve it.)
 *
 * The event row is now the durable unit of work:
 *   - `outcome` NULL      = not finalized; still owed a decision
 *   - `outcome` non-NULL  = a terminal decision was reached
 *                           (`applied`, `ignored`, `rejected`, `needs_review`,
 *                            `deferred_exhausted`)
 *   - `next_attempt_at`   = when the retry sweep should look at it again
 *                           (`src/jobs/payment-webhooks.js`)
 *
 * `processed_at` keeps its meaning ("a terminal decision was reached"), and
 * now also covers rejected / ignored / exhausted events, not only applied ones.
 *
 * No backfill: existing rows have no `next_attempt_at`, and the sweep only
 * looks at rows where it is set, so history is never re-processed.
 *
 * Both tables stay PLATFORM_SCOPED; no constraint changes. The index leads
 * with `outcome` for the sweep's `outcome IS NULL AND next_attempt_at <= now`
 * scan. Index names stay under MySQL's 64-character identifier limit.
 */

const TABLES = [
  { table: 'payment_webhook_events', index: 'payment_webhook_events_outcome_next_attempt_idx' },
  { table: 'subscription_webhook_events', index: 'subscription_webhook_events_outcome_next_attempt_idx' },
];

exports.up = async function up(knex) {
  for (const { table, index } of TABLES) {
    await knex.schema.alterTable(table, (t) => {
      t.string('outcome', 40).nullable().comment('NULL until a terminal decision: applied, ignored, rejected, needs_review, deferred_exhausted.');
      t.json('outcome_detail').nullable().comment('Why: reason codes, expected vs observed, or the last transient error.');
      t.integer('attempt_count').unsigned().notNullable().defaultTo(0).comment('Processing attempts so far.');
      t.datetime('last_attempt_at').nullable();
      t.datetime('next_attempt_at').nullable().comment('When the retry sweep should next look at this event. NULL = not scheduled.');
      t.index(['outcome', 'next_attempt_at'], index);
    });
  }
};

exports.down = async function down(knex) {
  for (const { table, index } of TABLES) {
    await knex.schema.alterTable(table, (t) => {
      t.dropIndex(['outcome', 'next_attempt_at'], index);
      t.dropColumn('outcome');
      t.dropColumn('outcome_detail');
      t.dropColumn('attempt_count');
      t.dropColumn('last_attempt_at');
      t.dropColumn('next_attempt_at');
    });
  }
};
