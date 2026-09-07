'use strict';

/**
 * `pos_shifts` — PLAN.md Phase 4, DATABASE.md's own `pos_shifts |
 * terminal_id, user_id, opening_float, counted_cash, expected_cash,
 * variance, opened_at, closed_at | Blind cash-up — counted before
 * expected is revealed` row, plus one addition beyond that draft: a
 * `currency` column. Every other money-carrying table this same migration
 * set creates (`pos_order_settlements`) has one, per ARCHITECTURE.md's own
 * "every money column carries its currency" rule — DATABASE.md's original
 * sketch for this table simply omitted it, and this pass corrects that
 * rather than repeating the omission.
 *
 * Scope: PROPERTY_SCOPED, following `pos_terminals`.
 *
 * ── BLIND CASH-UP IS A STRUCTURAL GUARANTEE, NOT A UI CONVENTION ─────────
 *
 * PRODUCT_REQUIREMENTS.md §3.4/§3.19: "the operator counts before seeing
 * what the system expects, or the variance figure is worthless." This is
 * enforced by `pos/service.js`'s `closeShift` accepting `counted_cash` as
 * INPUT and computing + returning `expected_cash`/`variance` in that same
 * response — no earlier endpoint on an open shift ever exposes what the
 * system expects, so there is no code path for a client to peek before
 * submitting a count, the same discipline `night-audit`'s own recovery
 * model applies to trusting reality over a stored status.
 *
 * ── ONE OPEN SHIFT PER TERMINAL, ENFORCED IN APPLICATION CODE ────────────
 *
 * `closed_at IS NULL` marks an open shift, but MySQL's unique-index
 * semantics treat every NULL as distinct — a `UNIQUE(terminal_id,
 * closed_at)` index would NOT stop two concurrently-open shifts on the
 * same terminal. `openShift` (`pos/service.js`) instead takes a
 * `SELECT ... FOR UPDATE` gap lock on `WHERE terminal_id = ? AND
 * closed_at IS NULL` before inserting, inside one transaction — the same
 * row/gap-locking discipline ARCHITECTURE.md §5 requires for every named
 * concurrency race in this codebase, applied here since no DB constraint
 * alone can express "at most one open row."
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
  await knex.schema.createTable('pos_shifts', (table) => {
    table.comment('One open/closed cash-up shift on a terminal. Scope: PROPERTY_SCOPED. Never deleted — a historical shift stays the audit record it always was.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('terminal_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable().comment('The operator who opened (and, usually, closes) this shift.');

    table.decimal('opening_float', 12, 2).notNullable();
    table.decimal('counted_cash', 12, 2).nullable().comment('Entered by the operator at close, BEFORE expected_cash is computed — see migration header.');
    table.decimal('expected_cash', 12, 2).nullable().comment('Computed at close time from this shift\'s own cash settlements. Never exposed before counted_cash is submitted.');
    table.decimal('variance', 12, 2).nullable().comment('counted_cash - expected_cash, recorded either way.');
    table.string('currency', 3).notNullable().comment('ARCHITECTURE.md: every money column carries its currency — set from the property\'s own base_currency at open time. Missing from this table\'s original DATABASE.md draft; added here to match every sibling POS table.');

    table.datetime('opened_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('closed_at').nullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'pos_shifts_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'terminal_id'], 'pos_shifts_tenant_id_property_id_terminal_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_terminals')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'user_id'], 'pos_shifts_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'terminal_id', 'closed_at'], 'pos_shifts_tenant_id_property_id_terminal_id_closed_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_shifts');
};
