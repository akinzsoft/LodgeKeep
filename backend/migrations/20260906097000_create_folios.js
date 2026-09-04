'use strict';

/**
 * Folios — a deliberately minimal stub (this session's confirmed decision).
 * DATABASE.md §1's full eventual shape: "folios | reservation_id,
 * folio_number, billed_to, company_profile_id, currency, status |
 * Multiple folios per reservation for split billing." Cashiering (§3.4,
 * PLAN.md Phase 2's other bullet) is explicitly out of THIS pass's scope —
 * this table exists only because ARCHITECTURE.md §11's state machine names
 * "folio open" as a precondition of `CONFIRMED -> CHECKED_IN` and "folio
 * closed" as part of `CHECKED_IN -> CHECKED_OUT`, and TESTING.md FD-1/FD-4
 * check for exactly that.
 *
 * Scope: PROPERTY_SCOPED.
 *
 * Built now: `reservation_id`, `folio_number`, `status`, `balance`,
 * `currency` — enough for check-in to open one and check-out to close one,
 * and for FD-4's "checkout blocked until balance settled" to be checkable
 * at all (trivially true here, since nothing in this pass can post a charge
 * against `balance`, so it never leaves 0.00).
 *
 * NOT built: `billed_to`, `company_profile_id` (no company-profiles concept
 * exists), and — the real omission — `folio_line_items`. No charges, no
 * payments, no split billing, no cashiering UI. `balance` is a plain
 * DECIMAL column with no writer other than this migration's own default;
 * Cashiering's future `folio_line_items` table attaches to `folio_id`
 * cleanly when it lands, without needing this table reshaped.
 *
 * `folio_number` is a ULID like `reservations.confirmation_number`
 * (ARCHITECTURE.md §10) — a folio can be shown to a guest on a printed
 * receipt, so it gets the same "safe to expose, reveals nothing" treatment.
 *
 * `UNIQUE(reservation_id, folio_number)` — DATABASE.md §2's required set.
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
  await knex.schema.createTable('folios', (table) => {
    table.comment(
      'A minimal folio stub opened at check-in, closed at check-out. Scope: PROPERTY_SCOPED. No line items — see file header; full Cashiering is out of this pass.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('reservation_id').unsigned().notNullable();

    table.string('folio_number', 26).notNullable().comment('ULID (ARCHITECTURE.md section 10) — safe to print on a guest-facing receipt.');

    table.enu('status', ['open', 'closed']).notNullable().defaultTo('open');

    table
      .decimal('balance', 12, 2)
      .notNullable()
      .defaultTo('0.00')
      .comment('Never written to by this pass beyond its default — no charge-posting path exists yet (Cashiering).');
    table.string('currency', 3).notNullable();

    table.datetime('opened_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('closed_at').nullable();

    timestamps(knex, table);

    table.unique(['reservation_id', 'folio_number'], { indexName: 'folios_reservation_id_folio_number_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'folios_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'reservation_id'], 'folios_tenant_id_property_id_reservation_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'reservation_id'], 'folios_tenant_id_property_id_reservation_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('folios');
};
