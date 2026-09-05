'use strict';

/**
 * `folio_line_items` — PLAN.md Phase 2.5 step 1, "the real folio ledger,"
 * ARCHITECTURE.md §8 (immutability — "already applied to
 * `folio_line_items`"), §12.1 (tax), §7 (a captured payment's folio effect).
 * DATABASE.md §1's own row for this table: "Void, never delete. type:
 * room_charge/tax/pos_charge/payment/refund/adjustment."
 *
 * This is the table the Phase 2 `folios` stub's own migration header named
 * as "the real omission" and left for this pass: "Cashiering's future
 * `folio_line_items` table attaches to `folio_id` cleanly when it lands,
 * without needing this table reshaped." It does — no change to `folios`
 * itself was needed beyond this pass's own composite-key migration.
 *
 * ── SIGN CONVENTION (this session's confirmed decision, not literal spec
 * text — DATABASE.md names the six `type` values but not their arithmetic
 * sign) ──────────────────────────────────────────────────────────────────
 *
 * `amount` is SIGNED and IS the line's exact effect on the folio balance —
 * `folios.balance` is always `sumMoney` of every non-voided line on that
 * folio (`src/shared/money.js`), never a second, independently-maintained
 * total:
 *
 *   room_charge, tax, pos_charge   positive  (increases what is owed)
 *   payment                        negative  (reduces what is owed)
 *   refund                         positive  (reverses a prior payment's
 *                                             credit — ARCHITECTURE.md §8's
 *                                             own correction example uses
 *                                             the same "offsetting entry"
 *                                             shape)
 *   adjustment                     either     (a correction can move the
 *                                             balance either way — see
 *                                             `related_line_item_id` below)
 *
 * ── VOID vs. CORRECTION (ARCHITECTURE.md §8) ────────────────────────────
 *
 * "Void, never delete" is a MUTATION of exactly the three audited fields
 * below (`voided_at`, `voided_by_user_id`, `void_reason`) — nothing else on
 * the row ever changes after insert. A CORRECTION (fixing a wrong amount)
 * is different and does NOT touch the original row at all: it posts a new
 * `adjustment` line reversing the original (via `related_line_item_id`)
 * plus a new correct charge — §8's own worked example. Both mechanisms
 * coexist; neither is a substitute for the other.
 *
 * `related_line_item_id` (beyond DATABASE.md §1's baseline column list,
 * added here the same way Phase 2 added columns beyond that file's initial
 * sketch and then updated it to match) links an adjustment or a tax line
 * back to the charge it corrects or taxes — self-referencing, hence this
 * table's own 3-column composite parent key below.
 *
 * `tax_amount` is INFORMATIONAL ONLY (the tax portion attributable to a
 * charge line, for reporting) — it does NOT itself move the balance; the
 * actual balance effect of a tax is its own separate `type: 'tax'` line, so
 * a tax can be voided independently of the charge that generated it without
 * ever touching the charge's own row. `tax_amount` stays `0.00` on every row
 * type other than a charge that had tax computed against it.
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
  await knex.schema.createTable('folio_line_items', (table) => {
    table.comment(
      'One entry on a folio ledger. Void, never delete (ARCHITECTURE.md section 8) — only voided_at/voided_by_user_id/void_reason ever change after insert. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('folio_id').unsigned().notNullable();

    table.enu('type', ['room_charge', 'tax', 'pos_charge', 'payment', 'refund', 'adjustment']).notNullable();
    table.string('description', 255).notNullable();

    table.decimal('amount', 12, 2).notNullable().comment('Signed — the line\'s exact effect on folio balance. See migration header for the sign convention per type.');
    table.string('currency', 3).notNullable();
    table.decimal('tax_amount', 12, 2).notNullable().defaultTo('0.00').comment('Informational only — does not itself move the balance. See migration header.');

    table.string('payment_method', 30).nullable().comment('Set on payment/refund rows only (e.g. "cash", "paystack").');
    table
      .bigInteger('payment_id')
      .unsigned()
      .nullable()
      .comment('Links a payment/refund-type line back to its payments row. Null for every other type.');

    table
      .bigInteger('related_line_item_id')
      .unsigned()
      .nullable()
      .comment('Links a tax line to the charge it taxes, or an adjustment to the line it corrects (ARCHITECTURE.md section 8). Self-referencing — see migration header.');

    table.date('business_date').notNullable();

    table
      .bigInteger('posted_by_user_id')
      .unsigned()
      .nullable()
      .comment('Null for a system-posted line (night audit\'s room charges) — audit_log.source distinguishes "job" from "web" for exactly this case.');

    table.datetime('voided_at').nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();
    table.string('void_reason', 500).nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'folio_line_items_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'folio_line_items_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'folio_id'], 'folio_line_items_tenant_id_property_id_folio_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('folios')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'payment_id'], 'folio_line_items_tenant_id_property_id_payment_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('payments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(
        ['tenant_id', 'property_id', 'related_line_item_id'],
        'folio_line_items_tenant_id_property_id_related_line_item_id_fk'
      )
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('folio_line_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'posted_by_user_id'], 'folio_line_items_tenant_id_posted_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'folio_line_items_tenant_id_voided_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'folio_id', 'business_date'], 'folio_line_items_folio_business_date_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('folio_line_items');
};
