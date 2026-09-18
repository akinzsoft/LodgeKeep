'use strict';

/**
 * Gap closure (user-reported, Booking screen): the Rate code picker was
 * showing every active, property-wide rate code regardless of which room
 * type was searched — correct against the schema as it stood (`rate_codes`
 * carries no room-type relationship at all, confirmed before that pass
 * shipped), but not what a hotel actually wants: "put only the price of
 * the room type selected." Closing that for real needs an actual
 * room-type-to-rate-code link, which this migration adds — confirmed with
 * the user (AskUserQuestion) as the recommended shape over a many-to-many
 * table or a fragile code-name-matching heuristic.
 *
 * `room_types.primary_rate_code_id` — nullable, one rate code per room
 * type, not the other way around: a rate code itself stays a plain,
 * unmodified property-wide row (no new column on `rate_codes`), so an
 * existing rate code can still be reused as more than one room type's own
 * primary without needing its own multi-valued relationship. A room type
 * with no primary set (the common case for any room type created before
 * this migration, or one nobody has configured yet) falls back to the
 * full eligible-codes list — "no data to prefer, don't invent one,"
 * the same reasoning `rate-code-eligibility.js`'s own empty-result
 * fallback already uses.
 *
 * 3-column composite FK — `rate_codes` is PROPERTY_SCOPED, the exact same
 * `rate_calendar`/`reservations.preferred_room_id` pattern already
 * established for a PROPERTY_SCOPED table referencing another one: the
 * referenced rate code must belong to the SAME property. Nullable
 * throughout — MySQL's default MATCH SIMPLE semantics skip FK enforcement
 * when any composite-FK column is NULL, the same reasoning
 * `20260913090000_add_preferred_room_to_reservations.js` already relies on.
 *
 * RESTRICT, not CASCADE or SET NULL: this column is edited only through
 * `updateRoomType`'s own `room_types.update` gate (super_admin), which is
 * the one deliberate place a stale reference gets cleared explicitly, not
 * silently by a rate code's own lifecycle.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('room_types', (table) => {
    table
      .bigInteger('primary_rate_code_id')
      .unsigned()
      .nullable()
      .comment('This room type\'s own default rate code, shown first on Booking\'s Rate code picker. Nullable — a room type with none configured falls back to the full eligible-codes list.');
  });

  await knex.schema.alterTable('room_types', (table) => {
    table
      .foreign(['tenant_id', 'property_id', 'primary_rate_code_id'], 'room_types_tenant_id_property_id_primary_rate_code_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rate_codes')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('room_types', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'primary_rate_code_id'], 'room_types_tenant_id_property_id_primary_rate_code_id_foreign');
    table.dropColumn('primary_rate_code_id');
  });
};
