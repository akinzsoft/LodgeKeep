'use strict';

/**
 * `payment_webhook_events` — ARCHITECTURE.md §7 ("Provider webhook events
 * are persisted as their own records, separate from the payment record they
 * affect ... not folded into `payments`"), API.md §7 (verified, persisted,
 * deduplicated, processed idempotently, `200` on persistence). DATABASE.md
 * §1's own row for this table; `UNIQUE(provider, provider_event_id)` per
 * DATABASE.md §2's explicit list.
 *
 * ── SCOPE: PLATFORM_SCOPED, FOLLOWING `auth_events`'S OWN PRECEDENT ──────
 *
 * A gateway webhook (`POST /api/v1/webhooks/:provider`) arrives with no
 * session, no tenant context — the exact bootstrapping problem
 * `auth_events` was built to solve for a failed login attempt. The provider
 * only ever tells us ITS OWN reference (`data.reference`, which we
 * ourselves generated and embedded in the transaction at initialize time);
 * resolving which tenant/payment that reference belongs to is a lookup this
 * table's OWN WRITER does after persisting the raw event, never something
 * the write path can assume up front. `tenant_id`/`property_id` are
 * therefore attribution, not scope — nullable, populated once (if ever) the
 * matching `payments` row is found — following `auth_events`'
 * `attributionColumns` pattern in `src/shared/table-scopes.js` exactly
 * rather than inventing a new shape for the identical problem.
 *
 * `payload` is the RAW, VERIFIED webhook body (JSON) — API.md §7:
 * "Persisted immediately, before processing — a crash mid-handling must not
 * lose the event." `verified` records whether the signature check passed
 * (a failed-verification event is still persisted, per that same rule,
 * rather than silently dropped before it can be audited as a possible
 * attack). `processed_at` is null until the effect (payment state
 * transition + folio posting) has actually been applied — see
 * `src/modules/cashiering/service.js`'s `handlePaystackWebhook`.
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
  await knex.schema.createTable('payment_webhook_events', (table) => {
    table.comment(
      'The raw record of what a payment gateway actually sent, independent of what the payments row currently says (ARCHITECTURE.md section 7). Scope: PLATFORM_SCOPED with nullable tenant/property attribution — see migration header.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().nullable().comment('Attribution, not scope — populated once resolved. See migration header.');
    table.bigInteger('property_id').unsigned().nullable().comment('Attribution, not scope — see migration header.');

    table.string('provider', 30).notNullable();
    table.string('provider_event_id', 150).notNullable().comment('The gateway\'s own event id — deduplication key (API.md section 7).');

    table.json('payload').notNullable().comment('The raw, already-verified webhook body.');
    table.boolean('verified').notNullable().comment('Whether the signature check passed. A failed check is still persisted, never silently dropped.');
    table.datetime('processed_at').nullable().comment('Set once the payment state transition + folio posting has actually been applied.');

    table
      .bigInteger('related_payment_id')
      .unsigned()
      .nullable()
      .comment('The local payments row this event was matched to, once resolved. Not scope-composited (this table carries no reliable tenant context) — a plain reference to payments.id.');

    timestamps(knex, table);

    table.unique(['provider', 'provider_event_id'], { indexName: 'payment_webhook_events_provider_provider_event_id_unique' });

    // Following `auth_events`' exact shape for the identical nullable-
    // attribution case: MySQL skips a foreign key check when the referencing
    // column is NULL, so these constraints are real and enforced the moment
    // tenant_id/property_id ARE populated, without requiring them up front.
    table
      .foreign('tenant_id', 'payment_webhook_events_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id'], 'payment_webhook_events_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign('related_payment_id', 'payment_webhook_events_related_payment_id_foreign')
      .references('id')
      .inTable('payments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // Tenant_id-leading, following the isolation suite's own rule that any
    // index on a table carrying tenant_id must lead with it.
    table.index(['tenant_id', 'property_id'], 'payment_webhook_events_tenant_id_property_id_index');
    table.index(['related_payment_id'], 'payment_webhook_events_related_payment_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('payment_webhook_events');
};
