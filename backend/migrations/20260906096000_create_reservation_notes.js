'use strict';

/**
 * Reservation notes — DATABASE.md §1: "reservation_notes | reservation_id,
 * note, user_id | Special requests, front-desk notes."
 *
 * Scope: PROPERTY_SCOPED. Append-only (like `audit_log`/`auth_events` in
 * this schema) — no status, no update path, no unique key: two notes with
 * identical text a minute apart are two real notes, not a collision.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('reservation_notes', (table) => {
    table.comment(
      'A free-text note against a reservation (special request, front-desk note). Scope: PROPERTY_SCOPED. Append-only.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('reservation_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    table.text('note').notNullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table
      .foreign(['tenant_id', 'property_id'], 'reservation_notes_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'reservation_id'], 'reservation_notes_tenant_id_property_id_reservation_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 2-column: users is TENANT_SCOPED.
    table
      .foreign(['tenant_id', 'user_id'], 'reservation_notes_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'reservation_id'], 'reservation_notes_tenant_id_property_id_reservation_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('reservation_notes');
};
