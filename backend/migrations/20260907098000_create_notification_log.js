'use strict';

/**
 * The delivery log — DATABASE.md §1's `notification_log` row,
 * PRODUCT_REQUIREMENTS.md §3.21: "every send recorded with recipient,
 * template, timestamp, and delivery status from the provider webhook (sent /
 * delivered / bounced / failed). This log is the answer to 'the guest says
 * they never got it' — without it that question is unanswerable."
 *
 * Scope: PROPERTY_SCOPED, following `email_templates`.
 *
 * `recipient_email` is a plain string, not an FK: the recipient may be a
 * guest (TENANT_SCOPED `guests`, not always present for every send — a
 * staff-invitation email has no guest at all) or a staff `users` row —
 * two different parent tables for one column is not expressible as a single
 * FK, and DATABASE.md's own row names the column generically as
 * "recipient." `reservation_id` is the one specific, nullable FK this pass's
 * actual senders need (every template this pass emits is reservation- or
 * checkout-triggered).
 *
 * API.md §6 explicitly names this table as cursor-paginated ("high-volume ...
 * notification log"); DATABASE.md's own indexing note (section on indexes)
 * says it "needs an index on recipient for the support lookup" — both are
 * satisfied by `notification_log_recipient_index` below.
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
  await knex.schema.createTable('notification_log', (table) => {
    table.comment('One row per attempted send — the answer to "did the guest actually get this." Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.string('recipient_email', 255).notNullable();
    table.string('template_key', 60).notNullable();
    table.enu('channel', ['email']).notNullable().defaultTo('email').comment('Single channel this pass (PRODUCT_REQUIREMENTS.md section 3.21 names SMS/WhatsApp as future, pluggable additions).');

    table.enu('status', ['sent', 'delivered', 'bounced', 'failed']).notNullable();
    table.string('provider_ref', 255).nullable().comment('The provider\'s own message id, for webhook correlation.');
    table.text('failed_reason').nullable();

    table.bigInteger('reservation_id').unsigned().nullable();

    table.datetime('sent_at').nullable();
    table.datetime('delivered_at').nullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'notification_log_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'reservation_id'], 'notification_log_tenant_id_property_id_reservation_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'recipient_email'], 'notification_log_recipient_index');
    table.index(['tenant_id', 'property_id', 'status'], 'notification_log_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('notification_log');
};
