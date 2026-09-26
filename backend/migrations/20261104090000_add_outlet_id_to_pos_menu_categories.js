'use strict';

/**
 * `pos_menu_categories.outlet_id` — gap closure, user-reported: a menu
 * category belongs to ONE outlet, not the whole property. A category created
 * while managing the Main Bar must never show under the supermarket. Two
 * outlets may each register a category with the same name, so the unique
 * key moves from (property_id, name) to (outlet_id, name).
 *
 * Scope stays PROPERTY_SCOPED — outlet_id is an ordinary business column
 * (like pos_terminals.outlet_id), reaching pos_outlets through the same
 * (tenant_id, property_id, outlet_id) composite FK, so a category can never
 * point at another property's outlet.
 *
 * Existing rows (see `planCategoryOutletFanOut`):
 *   - a category some menu items use goes to the outlet(s) those items
 *     belong to — one copy per outlet, the original row kept for the lowest
 *     outlet id (matching is case-insensitive, like the original backfill);
 *   - a category no item uses goes to the property's oldest outlet, not to
 *     every outlet — copying it everywhere would recreate the reported bug;
 *   - a category at a property with no outlet at all is deleted: no menu
 *     item could ever have used it, and there is nothing to attach it to.
 *     down() cannot bring those back (a documented one-way step; the dev
 *     database has none).
 *
 * The old unique key is dropped BEFORE the fan-out, since a second copy of
 * a name at the same property would violate it.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
const FK_NAME = 'pos_menu_categories_outlet_foreign';
const OLD_UNIQUE = 'pos_menu_categories_property_id_name_unique';
const NEW_UNIQUE = 'pos_menu_categories_outlet_id_name_unique';

/**
 * Pure — decides what up() does with one category row.
 * @param {Array<number|string>} itemOutletIds - distinct outlet ids, ascending, whose items use the name.
 * @param {Array<number|string>} propertyOutletIds - every outlet id at the property (any status), ascending.
 * @returns {{updateOutletId, insertOutletIds: Array} | {delete: true}}
 */
function planCategoryOutletFanOut(itemOutletIds, propertyOutletIds) {
  if (itemOutletIds.length > 0) {
    const [first, ...rest] = itemOutletIds;
    return { updateOutletId: first, insertOutletIds: rest };
  }
  if (propertyOutletIds.length > 0) return { updateOutletId: propertyOutletIds[0], insertOutletIds: [] };
  return { delete: true };
}

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.bigInteger('outlet_id').unsigned().nullable().after('property_id').comment('The one outlet this category belongs to.');
  });
  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.dropUnique(['property_id', 'name'], OLD_UNIQUE);
  });

  const categories = await knex('pos_menu_categories').orderBy('id');
  for (const category of categories) {
    const itemRows = await knex('pos_menu_items')
      .where({ tenant_id: category.tenant_id, property_id: category.property_id })
      .whereRaw('LOWER(TRIM(category)) = LOWER(TRIM(?))', [category.name])
      .distinct('outlet_id')
      .orderBy('outlet_id');
    const outletRows = await knex('pos_outlets').where({ tenant_id: category.tenant_id, property_id: category.property_id }).orderBy('id').select('id');
    const plan = planCategoryOutletFanOut(
      itemRows.map((row) => row.outlet_id),
      outletRows.map((row) => row.id)
    );
    if (plan.delete) {
      await knex('pos_menu_categories').where({ id: category.id }).del();
      continue;
    }
    await knex('pos_menu_categories').where({ id: category.id }).update({ outlet_id: plan.updateOutletId });
    for (const outletId of plan.insertOutletIds) {
      await knex('pos_menu_categories').insert({
        tenant_id: category.tenant_id,
        property_id: category.property_id,
        outlet_id: outletId,
        name: category.name,
        sort_order: category.sort_order,
        status: category.status,
      });
    }
  }

  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.bigInteger('outlet_id').unsigned().notNullable().comment('The one outlet this category belongs to.').alter();
    table.unique(['outlet_id', 'name'], { indexName: NEW_UNIQUE });
    table.comment('Registered POS menu categories, each belonging to one outlet. Scope: PROPERTY_SCOPED. Archive, never delete.');
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], FK_NAME)
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  // Collapse the per-outlet copies back to one row per (property, name),
  // keeping the lowest id.
  const rows = await knex('pos_menu_categories').orderBy('id').select('id', 'property_id', 'name');
  const seen = new Set();
  const duplicateIds = [];
  for (const row of rows) {
    const key = `${row.property_id}::${String(row.name).trim().toLowerCase()}`;
    if (seen.has(key)) duplicateIds.push(row.id);
    else seen.add(key);
  }
  if (duplicateIds.length > 0) await knex('pos_menu_categories').whereIn('id', duplicateIds).del();

  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'outlet_id'], FK_NAME);
    table.dropUnique(['outlet_id', 'name'], NEW_UNIQUE);
    table.dropIndex(['tenant_id', 'property_id', 'outlet_id'], FK_NAME); // MySQL's own supporting index for the FK
  });
  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.dropColumn('outlet_id');
    table.unique(['property_id', 'name'], { indexName: OLD_UNIQUE });
    table.comment('Registered POS menu categories, shared by every outlet at the property. Scope: PROPERTY_SCOPED. Archive, never delete.');
  });
};

exports.planCategoryOutletFanOut = planCategoryOutletFanOut;
