'use strict';

/**
 * The door-open event store — PRODUCT_REQUIREMENTS.md §3.23 ("Every door-open
 * event ... is ingested and stored ... append-only and never editable from
 * the UI — this is evidence").
 *
 * APPEND-ONLY: the application layer has an INSERT path and read paths,
 * nothing else (ARCHITECTURE.md §1 data conventions). No column here is ever
 * updated after insert.
 *
 * Dedup key, deliberately diverging from DATABASE.md's forward-declared
 * `UNIQUE(lock_system, external_event_id)`: HiRead ProUSB's handheld-reader
 * export carries no vendor event id, so the natural key — which room, which
 * card, at which instant — IS the event's identity. It is computed AFTER room
 * matching and timezone conversion on purpose: the same physical event
 * exported once as a real Excel date cell and once as a text timestamp still
 * collides here, which a hash of the raw cell text would not catch.
 * Re-uploading an overlapping pull is routine (§3.23), and this constraint is
 * what makes it harmless. A future webhook adapter that DOES carry a vendor
 * id can add a nullable `external_event_id` column and its own unique index
 * without disturbing this one.
 *
 * `opened_at` is a true UTC instant — converted from the property's own
 * timezone at import (`properties.timezone`, whose first real reader this
 * is). `ingested_at` is when it reached us; §3.23 requires both, because
 * rules key off occurrence time, never ingestion time.
 *
 * `card_type`/`result` hold the raw mapped cell values (or NULL when the
 * column wasn't mapped); `is_guest_card` is the evaluated interpretation of
 * `card_type` against the staff's own "these values mean guest" choice,
 * frozen at import so a later mapping change can't silently re-interpret
 * stored evidence.
 *
 * Scope: PROPERTY_SCOPED.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('door_access_events', (table) => {
    table.comment('Append-only door-open events ingested from a lock system. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('room_id').unsigned().notNullable();

    table.string('lock_system', 40).notNullable().comment('The adapter that produced this event, e.g. hiread_prousb.');
    table.string('card_id', 100).notNullable();
    table.string('card_type', 100).nullable().comment('Raw mapped card-type cell, or NULL when no card-type column was mapped.');
    table
      .boolean('is_guest_card')
      .notNullable()
      .comment('true when card_type matched a staff-ticked guest value, or when no card-type column was mapped at all.');
    table.string('result', 20).notNullable().defaultTo('granted').comment('granted / denied.');

    table.datetime('opened_at').notNullable().comment('UTC occurrence instant.');
    table.datetime('ingested_at').notNullable().defaultTo(knex.fn.now());
    table.boolean('is_retrospective').notNullable().defaultTo(true).comment('Always true for manual_import.');
    table.string('import_ref', 36).notNullable().comment('One UUID per import commit — which upload produced this row.');
    table.bigInteger('imported_by_user_id').unsigned().notNullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table
      .foreign(['tenant_id', 'property_id'], 'door_access_events_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'door_access_events_tenant_property_room_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'imported_by_user_id'], 'door_access_events_tenant_imported_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.unique(['tenant_id', 'property_id', 'room_id', 'card_id', 'opened_at'], {
      indexName: 'door_access_events_natural_key_unique',
    });
    // Parent key for access_alert_events / door_access_stay_confirmations.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'door_access_events_tenant_property_id_unique' });
    // DATABASE.md's own indexing note: (property_id, room_id, opened_at).
    table.index(['tenant_id', 'property_id', 'room_id', 'opened_at'], 'door_access_events_room_timeline_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('door_access_events');
};
