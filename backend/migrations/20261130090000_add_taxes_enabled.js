'use strict';

/**
 * Per-tax On/Off switch: `taxes.enabled` (default on, so nothing changes until someone switches a tax). Every version
 * row of a tax code carries the same value; the tax engine skips a tax that is off.
 *
 * Taxes already ended under the old date system (no open version and none still live on the property's business
 * date) are backfilled OFF, so they stay off; their end dates are not touched. A tax still scheduled to end keeps
 * its end date and stays on until it passes.
 *
 * `down` refuses while any tax is off: dropping the column would silently switch those taxes back on.
 */

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE `taxes` ADD COLUMN `enabled` TINYINT(1) NOT NULL DEFAULT 1, ALGORITHM=INSTANT');

  const rows = await knex('taxes').select('id', 'tenant_id', 'property_id', 'tax_code', 'effective_to');
  const properties = await knex('properties').select('id', 'current_business_date');
  const businessDate = new Map(properties.map((p) => [String(p.id), p.current_business_date ? String(p.current_business_date).slice(0, 10) : null]));
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.tenant_id}|${row.property_id}|${row.tax_code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const versions of groups.values()) {
    const bd = businessDate.get(String(versions[0].property_id));
    const live = versions.some((v) => !v.effective_to || (bd && String(v.effective_to).slice(0, 10) >= bd));
    if (!live) await knex('taxes').whereIn('id', versions.map((v) => v.id)).update({ enabled: 0 });
  }
};

exports.down = async function down(knex) {
  const off = await knex('taxes').where({ enabled: 0 }).count({ n: '*' }).first();
  if (Number(off.n) > 0) {
    throw new Error('Cannot roll back: some taxes are switched off. Switch them on first, otherwise dropping the column would start charging them again.');
  }
  await knex.raw('ALTER TABLE `taxes` DROP COLUMN `enabled`');
};
