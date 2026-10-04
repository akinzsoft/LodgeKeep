'use strict';

/**
 * Supermarket Stage 3 — bulk CSV product import (user-requested), built as a
 * fifth entity type on the Data Migration pipeline (`import_runs`,
 * `import_row_errors`, `imported_record_map`). No new tables.
 *
 * - `import_runs.entity_type` gains `supermarket_products`.
 * - `import_runs.outlet_id` (nullable): the supermarket outlet a product run
 *   imports into. Composite FK to `pos_outlets (tenant_id, property_id, id)`;
 *   NULL for every other entity type, which MySQL's MATCH SIMPLE skips.
 * - `import_runs.committing_products_property_id`: a VIRTUAL generated
 *   column, the property id while a supermarket_products run is
 *   `committing` and NULL otherwise, with a UNIQUE index — at most one
 *   product import commits per property at a time (the catalogue is
 *   property-wide and menu item names carry no uniqueness, so two
 *   overlapping imports could otherwise each create the same product). The
 *   same one-active-row trick as `pos_outlet_payment_subaccounts`. It never
 *   locks anything the till uses (a FOR UPDATE on the outlet row would stall
 *   every new tab and sale there for the whole import).
 * - `imported_record_map.entity_type` gains `menu_item`, `stock_item`,
 *   `menu_category`, `stock_category` (the category rows are recorded only
 *   when the import created them, so undo never removes one it did not make). Barcodes, the recipe link, stock levels and the
 *   opening-stock receipt are found through the menu item / stock item and
 *   the `IMPORT-<run id>` movement reference, so they need no map rows.
 * - `import_row_errors.severity` gains `warning` (non-blocking findings).
 *
 * `down` refuses (rather than deleting data) once any row uses a new value.
 */

const RUN_TYPES = ['guests', 'reservations', 'companies', 'ar_balances'];
const MAP_TYPES = ['guest', 'reservation', 'company_profile', 'ar_account', 'ar_invoice'];
const SEVERITIES = ['error', 'duplicate_candidate', 'availability_conflict'];

const NEW_RUN_TYPES = [...RUN_TYPES, 'supermarket_products'];
const NEW_MAP_TYPES = [...MAP_TYPES, 'menu_item', 'stock_item', 'menu_category', 'stock_category'];
const NEW_SEVERITIES = [...SEVERITIES, 'warning'];

const RUN_TYPE_COMMENT = "One CSV template, and one run, per entity type — never a mixed-entity file. supermarket_products: Supermarket Stage 3 product import.";

function enumSql(values) {
  return values.map((v) => `'${v}'`).join(', ');
}

async function setEnums(knex, runTypes, mapTypes, severities) {
  await knex.raw(`ALTER TABLE import_runs MODIFY COLUMN entity_type ENUM(${enumSql(runTypes)}) NOT NULL COMMENT ?`, [RUN_TYPE_COMMENT]);
  await knex.raw(`ALTER TABLE imported_record_map MODIFY COLUMN entity_type ENUM(${enumSql(mapTypes)}) NOT NULL`);
  await knex.raw(`ALTER TABLE import_row_errors MODIFY COLUMN severity ENUM(${enumSql(severities)}) NOT NULL DEFAULT 'error'`);
}

async function ensureFkIndex(knex) {
  const [rows] = await knex.raw(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'import_runs' AND INDEX_NAME = 'import_runs_tenant_property_foreign' LIMIT 1"
  );
  if (rows.length === 0) await knex.raw('ALTER TABLE import_runs ADD INDEX import_runs_tenant_property_foreign (tenant_id, property_id)');
}

exports.up = async function up(knex) {
  await setEnums(knex, NEW_RUN_TYPES, NEW_MAP_TYPES, NEW_SEVERITIES);

  await knex.schema.alterTable('import_runs', (table) => {
    table
      .bigInteger('outlet_id')
      .unsigned()
      .nullable()
      .after('property_id')
      .comment('supermarket_products only: the supermarket outlet the products are imported into. Null for every other entity type.');
    table.index(['tenant_id', 'property_id', 'outlet_id'], 'import_runs_tenant_property_outlet_index');
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'import_runs_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });

  // MySQL may silently drop the index it created implicitly for the
  // (tenant_id, property_id) FK now that the index above can serve it too.
  // Keep it as an explicit index so `up` always ends in the same schema and
  // `down` (which leaves it) restores the original exactly.
  await ensureFkIndex(knex);

  await knex.raw(
    "ALTER TABLE import_runs ADD COLUMN committing_products_property_id BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'committing' AND entity_type = 'supermarket_products', property_id, NULL)) VIRTUAL, " +
      'ADD UNIQUE INDEX import_runs_one_committing_products_unique (committing_products_property_id)'
  );
};

exports.down = async function down(knex) {
  const [[runs], [maps], [warnings]] = await Promise.all([
    knex('import_runs').where({ entity_type: 'supermarket_products' }).count({ n: '*' }),
    knex('imported_record_map').whereIn('entity_type', ['menu_item', 'stock_item', 'menu_category', 'stock_category']).count({ n: '*' }),
    knex('import_row_errors').where({ severity: 'warning' }).count({ n: '*' }),
  ]);
  if (Number(runs.n) || Number(maps.n) || Number(warnings.n)) {
    throw new Error(
      'Refusing to roll back 20261120090000: supermarket product import data exists ' +
        `(${runs.n} run(s), ${maps.n} record-map row(s), ${warnings.n} warning finding(s)). Remove it deliberately first.`
    );
  }

  await knex.raw('ALTER TABLE import_runs DROP INDEX import_runs_one_committing_products_unique, DROP COLUMN committing_products_property_id');
  await knex.raw('ALTER TABLE import_runs DROP FOREIGN KEY import_runs_outlet_foreign');
  // `up` keeps the (tenant_id, property_id) FK's own index; make sure it is
  // there (a database migrated by an earlier draft may lack it), or dropping
  // ours is refused.
  await ensureFkIndex(knex);
  await knex.raw('ALTER TABLE import_runs DROP INDEX import_runs_tenant_property_outlet_index, DROP COLUMN outlet_id');
  await knex.raw(`ALTER TABLE import_runs MODIFY COLUMN entity_type ENUM(${enumSql(RUN_TYPES)}) NOT NULL COMMENT ?`, [
    "§3.20's own four supported inputs. One CSV template, and one run, per entity type — never a mixed-entity file.",
  ]);
  await knex.raw(`ALTER TABLE imported_record_map MODIFY COLUMN entity_type ENUM(${enumSql(MAP_TYPES)}) NOT NULL`);
  await knex.raw(`ALTER TABLE import_row_errors MODIFY COLUMN severity ENUM(${enumSql(SEVERITIES)}) NOT NULL DEFAULT 'error'`);
};
