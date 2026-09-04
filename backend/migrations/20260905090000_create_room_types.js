'use strict';

/**
 * Room types — PLAN.md Phase 1, PRODUCT_REQUIREMENTS.md §3.19, DATABASE.md §1
 * ("room_types | code, name, description, default_occupancy, base_rate,
 * photos (JSON)").
 *
 * Scope: PROPERTY_SCOPED (ARCHITECTURE.md §3 — "room_types, rate_codes,
 * taxes ... Two properties in the same tenant can have entirely different
 * room inventories and tax jurisdictions").
 *
 * This is the first Phase 1 table that a *later* PROPERTY_SCOPED table
 * (`rooms`, in the next migration) needs to reference. Every earlier
 * cross-table FK in this schema was PROPERTY_SCOPED-child -> TENANT_SCOPED-
 * parent (e.g. `user_property_access.role` -> `roles.code`), which only needs
 * a 2-column `(tenant_id, id)` parent key, because the parent has no property
 * dimension to also match. A PROPERTY_SCOPED child referencing a
 * PROPERTY_SCOPED parent needs a 3-column parent key —
 * `(tenant_id, property_id, id)` — because a 2-column key would let a room
 * reference a room type belonging to a *different property in the same
 * tenant*, which is exactly the isolation ARCHITECTURE.md §3 rules out. That
 * 3-column unique index is added below for `rooms` and `rate_calendar` to
 * reference in their own migrations.
 *
 * Lifecycle (DATABASE.md §3): `active -> archived`. "Historical reservations
 * and rate history reference them" — never hard-deleted, so `rooms.room_type_id`
 * and `rate_calendar.room_type_id` can safely be RESTRICT rather than
 * worrying about a vanishing parent.
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
  await knex.schema.createTable('room_types', (table) => {
    table.comment(
      'A room category a property sells (e.g. "Deluxe King"). Scope: PROPERTY_SCOPED. Deactivate via status, never delete — reservations and rate history reference this row (DATABASE.md §3).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .string('code', 30)
      .notNullable()
      .comment('Short machine key shown on rate plans and the room grid, e.g. "DLXK". Unique per property, not globally — two properties may both use "DLXK" for unrelated room types.');

    table.string('name', 150).notNullable();
    table.text('description').nullable();

    table
      .integer('default_occupancy')
      .unsigned()
      .notNullable()
      .comment('Standard adult occupancy this room type is sold at. A reservation may override it; this is the default shown at booking, not an enforced cap.');

    // DECIMAL, never FLOAT (ARCHITECTURE.md §1, §12) — this is what a rate
    // code's own base_rate defaults from until overridden per plan.
    table.decimal('base_rate', 12, 2).notNullable();

    table
      .json('photos')
      .nullable()
      .comment('Array of image URLs shown on the booking portal (PRODUCT_REQUIREMENTS.md §3.19). No upload pipeline exists yet — this column exists so one can be wired up without a schema change; nullable/empty until then.');

    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    // UNIQUE(property_id, code) — DATABASE.md §2.
    table.unique(['property_id', 'code'], { indexName: 'room_types_property_id_code_unique' });

    // The 3-column parent key `rooms` and `rate_calendar` reference — see file
    // header. Implied by the primary key (id is already unique), so it adds a
    // guarantee without constraining any data.
    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'room_types_tenant_id_property_id_id_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'room_types_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'room_types_tenant_id_property_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('room_types');
};
