'use strict';

/**
 * `pos_order_settlements.pos_shift_id` — the terminal shift that was open
 * when a sale was settled.
 *
 * Bug fix (the "test and review Shifts" pass): `closeShift` used to find a
 * shift's cash sales by time — every cash settlement on the terminal with
 * `settled_at >= shift.opened_at`. Both columns are whole-second DATETIMEs,
 * so a hand-over where one shift closes and the next opens in the same
 * second counted the previous shift's sales a second time, reporting a
 * false shortage against the incoming cashier (reproduced: a shift with no
 * sales and a correct ₦100.00 count showed a -₦21.50 variance). Stamping
 * the shift id at settle time makes the attribution a recorded fact rather
 * than a timestamp comparison.
 *
 * Nullable: a sale settled while no shift is open on its terminal (or a
 * QR guest order, which has no terminal) belongs to no shift.
 *
 * Existing rows are backfilled from the old time-window rule, oldest shift
 * first and only into still-unstamped rows, so a same-second overlap goes
 * to the earlier shift (the one whose drawer actually took the money)
 * rather than to both.
 */

exports.up = async function up(knex) {
  // The composite FK below needs (tenant_id, property_id, id) indexed on the
  // parent — the same parent key pos_terminals/room_types carry.
  await knex.schema.alterTable('pos_shifts', (table) => {
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_shifts_tenant_id_property_id_id_unique' });
  });

  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.bigInteger('pos_shift_id').unsigned().nullable().comment('Shift open on the terminal when this sale settled — the cash-up attribution. Null when no shift was open.');
    table
      .foreign(['tenant_id', 'property_id', 'pos_shift_id'], 'pos_order_settlements_shift_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_shifts')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
    table.index(['tenant_id', 'property_id', 'pos_shift_id'], 'pos_order_settlements_shift_index');
  });

  const shifts = await knex('pos_shifts').select('id', 'tenant_id', 'property_id', 'terminal_id', 'opened_at', 'closed_at').orderBy([{ column: 'opened_at' }, { column: 'id' }]);
  for (const shift of shifts) {
    const orderIds = knex('pos_orders').select('id').where({ tenant_id: shift.tenant_id, property_id: shift.property_id, terminal_id: shift.terminal_id });
    const query = knex('pos_order_settlements')
      .where({ tenant_id: shift.tenant_id, property_id: shift.property_id })
      .whereIn('pos_order_id', orderIds)
      .whereNull('pos_shift_id')
      .where('settled_at', '>=', shift.opened_at);
    if (shift.closed_at) query.where('settled_at', '<=', shift.closed_at);
    await query.update({ pos_shift_id: shift.id });
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'pos_shift_id'], 'pos_order_settlements_shift_foreign');
    table.dropIndex(['tenant_id', 'property_id', 'pos_shift_id'], 'pos_order_settlements_shift_index');
  });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropColumn('pos_shift_id');
  });
  await knex.schema.alterTable('pos_shifts', (table) => {
    table.dropUnique(['tenant_id', 'property_id', 'id'], 'pos_shifts_tenant_id_property_id_id_unique');
  });
};
