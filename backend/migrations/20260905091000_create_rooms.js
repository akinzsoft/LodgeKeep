'use strict';

/**
 * Physical room inventory — PLAN.md Phase 1 ("with bulk entry — hand-keying
 * 60 rooms is a real onboarding failure"), DATABASE.md §1 ("rooms |
 * room_number, floor, room_type_id, front_desk_status,
 * housekeeping_reported_status, has_discrepancy, connecting_room_id | Two
 * status columns by design (3.6)").
 *
 * Scope: PROPERTY_SCOPED.
 *
 * `front_desk_status` / `housekeeping_reported_status` / `has_discrepancy`
 * are real columns per DATABASE.md's own schema reference — included now so
 * Phase 2's front-desk and housekeeping modules don't need a schema
 * migration just to start reading/writing them — but their full status
 * vocabulary, transition rules, and discrepancy-detection logic belong to
 * those modules (PLAN.md Phase 2, PRODUCT_REQUIREMENTS.md §3.6/§3.3), not
 * Phase 1. The enums here are deliberately minimal (the two states every
 * room needs on day one) and additive: a later migration widening an enum
 * value list is backwards-compatible, per DATABASE.md's own migration rule.
 *
 * `connecting_room_id` is self-referential and, like `room_type_id`,
 * constrained to the *same property* via a 3-column composite FK against
 * `rooms(tenant_id, property_id, id)` — two connecting rooms in different
 * properties would be meaningless, the same reasoning `room_types`'s own
 * header gives for room_type_id.
 *
 * Lifecycle (DATABASE.md §3): `active -> out_of_service -> archived`.
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
  await knex.schema.createTable('rooms', (table) => {
    table.comment(
      'A physical, sellable room. Scope: PROPERTY_SCOPED. Never hard-deleted — historical reservations reference it (DATABASE.md §3).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .string('room_number', 20)
      .notNullable()
      .comment('As printed on the key/door, e.g. "204" or "12A" — a string, not a number, since real room numbers are not always numeric.');

    table.string('floor', 20).nullable();

    table.bigInteger('room_type_id').unsigned().notNullable();

    table
      .bigInteger('connecting_room_id')
      .unsigned()
      .nullable()
      .comment('Another room in this same property that physically connects to this one. Nullable; not every room connects to another.');

    // Phase 2 territory (front desk / housekeeping) — see file header for why
    // these columns exist now with a deliberately minimal vocabulary.
    table
      .enu('front_desk_status', ['vacant', 'occupied'])
      .notNullable()
      .defaultTo('vacant')
      .comment('Owned by the front-desk module (PLAN.md Phase 2) — Phase 1 only initialises it.');
    table
      .enu('housekeeping_reported_status', ['clean', 'dirty'])
      .notNullable()
      .defaultTo('clean')
      .comment('Owned by the housekeeping module (PLAN.md Phase 2) — Phase 1 only initialises it. A newly created room has never been occupied, so it starts clean.');
    table
      .boolean('has_discrepancy')
      .notNullable()
      .defaultTo(false)
      .comment('Set when front_desk_status and housekeeping_reported_status disagree — the housekeeping module\'s job to compute (PRODUCT_REQUIREMENTS.md §3.6), not Phase 1\'s.');

    table.enu('status', ['active', 'out_of_service', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    // UNIQUE(property_id, room_number) — DATABASE.md §2. TESTING.md SET-2/SET-3.
    table.unique(['property_id', 'room_number'], { indexName: 'rooms_property_id_room_number_unique' });

    // Parent key for connecting_room_id's self-referential FK below.
    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'rooms_tenant_id_property_id_id_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'rooms_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 3-column composite: a room's type must belong to the SAME property, not
    // just the same tenant (see room_types migration's header).
    table
      .foreign(['tenant_id', 'property_id', 'room_type_id'], 'rooms_tenant_id_property_id_room_type_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('room_types')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // Self-referential, same reasoning: a connecting room must be in this
    // same property.
    table
      .foreign(['tenant_id', 'property_id', 'connecting_room_id'], 'rooms_tenant_id_property_id_connecting_room_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'rooms_tenant_id_property_id_status_index');
    table.index(['tenant_id', 'property_id', 'room_type_id'], 'rooms_tenant_id_property_id_room_type_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('rooms');
};
