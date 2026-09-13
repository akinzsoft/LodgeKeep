'use strict';

/**
 * First-use-after-check-in confirmations (confirmed scope, Phase 7): the
 * FIRST guest-card door-open inside a stay's room assignment, recorded
 * once per reservation as a low-priority "the key works, the guest got in"
 * notice.
 *
 * Its own table rather than an `info` severity on `access_alerts`: it has
 * no lifecycle (nothing to acknowledge or resolve — a mandatory resolution
 * reason for a confirmation would be meaningless), no email and no bell.
 *
 * `UNIQUE(tenant_id, property_id, reservation_id)` makes "once per stay" a
 * database guarantee. Every later door-open during the same stay is
 * deliberately NOT recorded anywhere beyond the append-only event store —
 * ordinary guest movement is not a fraud signal, and a running log of it
 * would be both alert fatigue and exactly the sensitive movement data
 * §3.23's legal/privacy note warns about.
 *
 * Scope: PROPERTY_SCOPED.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('door_access_stay_confirmations', (table) => {
    table.comment('First guest-card door-open after check-in, once per reservation. No lifecycle. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('reservation_id').unsigned().notNullable();
    table.bigInteger('room_id').unsigned().notNullable();
    table.bigInteger('door_access_event_id').unsigned().notNullable();
    table.string('card_id', 100).notNullable();
    table.datetime('opened_at').notNullable().comment('Copied from the event, UTC.');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table
      .foreign(['tenant_id', 'property_id'], 'door_access_stay_conf_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'reservation_id'], 'door_access_stay_conf_reservation_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'door_access_stay_conf_room_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'door_access_event_id'], 'door_access_stay_conf_event_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('door_access_events')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.unique(['tenant_id', 'property_id', 'reservation_id'], { indexName: 'door_access_stay_conf_reservation_unique' });
    table.index(['tenant_id', 'property_id', 'opened_at'], 'door_access_stay_conf_opened_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('door_access_stay_confirmations');
};
