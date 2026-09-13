'use strict';

/**
 * `pos_order_settlements` — tender, and one payment per settlement.
 *
 * - `tender`: how the check was actually paid — 'cash' | 'card' | 'nqr' |
 *   'room_charge'. `method` stays exactly as it is (every existing branch
 *   keys off it; NQR still settles as `method: 'card'`), so reports can tell
 *   NQR from Card without touching settlement logic. Existing rows are
 *   backfilled from `method`: historical NQR sales were never distinguishable
 *   and read as 'card' — an accepted, stated imprecision.
 * - `UNIQUE(tenant_id, property_id, payment_id)`: a captured payment can fund
 *   at most one settlement, enforced by the database, not only by the check
 *   in `settleOrder`. MySQL treats every NULL as distinct, so cash and room
 *   charge settlements (no payment row) never collide.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.string('tender', 12).nullable().comment("How the check was paid: cash | card | nqr | room_charge. NQR settles as method 'card'.");
  });
  await knex('pos_order_settlements').whereNull('tender').update({ tender: knex.ref('method') });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.unique(['tenant_id', 'property_id', 'payment_id'], { indexName: 'pos_order_settlements_payment_id_unique' });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropUnique(['tenant_id', 'property_id', 'payment_id'], 'pos_order_settlements_payment_id_unique');
  });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropColumn('tender');
  });
};
