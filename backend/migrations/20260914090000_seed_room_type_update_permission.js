'use strict';

/**
 * Gap closure (user-reported): "update room type and Base rate only super
 * admin" — confirmed with the user before building: editing ANY field of an
 * existing room type (name, occupancy, description, base rate) should
 * require `super_admin`, not the broader `setup.manage` `admin`/`super_admin`
 * split every other Setup mutation uses. `admin` keeps create/archive
 * (`setup.manage`, unchanged) but loses edit.
 *
 * A genuinely new asymmetry within Setup — until now the matrix's own text
 * (SECURITY.md §5) never distinguished `admin` from `super_admin` on any
 * single action; `super_admin`'s only documented extra was "billing,
 * cross-property," nothing endpoint-specific. Written down in SECURITY.md
 * directly, not left implicit in route code alone, per that file's own rule.
 */

exports.up = async function up(knex) {
  const key = 'room_types.update';
  const existing = await knex('permissions').where({ permission_key: key }).first();
  if (!existing) {
    await knex('permissions').insert({ permission_key: key, name: 'Update a room type (incl. base rate)', domain: 'setup' });
  }
};

exports.down = async function down(knex) {
  await knex('permissions').where({ permission_key: 'room_types.update' }).delete();
};
