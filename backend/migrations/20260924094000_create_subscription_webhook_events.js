'use strict';

/**
 * `subscription_webhook_events` — PLAN.md Phase 5, mirroring
 * `payment_webhook_events`' exact shape and reasoning (its own migration's
 * header applies verbatim, substituting `subscription_payments` for
 * `payments`). Kept as its OWN, parallel table rather than widening
 * `payment_webhook_events.related_payment_id`'s existing real FK to admit
 * a second target table — that column points at `payments.id` specifically
 * today; turning it into a polymorphic reference (like `audit_log`'s
 * `entity_type`/`entity_id`, which carries no FK at all by design) would
 * be a real, reviewable schema change to a working, tested guest-payment
 * table for a feature that has nothing to do with guest payments. A
 * second, structurally identical table is the lower-risk choice, matching
 * this whole pass's own "genuinely separate relationship, genuinely
 * separate mechanism" decision for the gateway adapter itself.
 *
 * Scope: PLATFORM_SCOPED with nullable tenant_id attribution, following
 * `payment_webhook_events`/`auth_events`.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('subscription_webhook_events', (table) => {
    table.comment(
      'The raw record of what the billing gateway actually sent, independent of what the subscription_payments row currently says. Mirrors payment_webhook_events exactly, kept separate rather than widened — see migration header. Scope: PLATFORM_SCOPED with nullable tenant_id attribution.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().nullable().comment('Attribution, not scope — populated once resolved.');

    table.string('provider', 30).notNullable();
    table.string('provider_event_id', 150).notNullable();

    table.json('payload').notNullable();
    table.boolean('verified').notNullable();
    table.datetime('processed_at').nullable();

    table
      .bigInteger('related_subscription_payment_id')
      .unsigned()
      .nullable()
      .comment('The local subscription_payments row this event was matched to, once resolved.');

    timestamps(knex, table);

    table.unique(['provider', 'provider_event_id'], { indexName: 'subscription_webhook_events_provider_event_id_unique' });

    table
      .foreign('tenant_id', 'subscription_webhook_events_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign('related_subscription_payment_id', 'subscription_webhook_events_related_payment_id_foreign')
      .references('id')
      .inTable('subscription_payments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id'], 'subscription_webhook_events_tenant_id_index');
    table.index(['related_subscription_payment_id'], 'subscription_webhook_events_related_payment_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('subscription_webhook_events');
};
