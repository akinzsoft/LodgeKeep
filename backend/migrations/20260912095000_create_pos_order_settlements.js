'use strict';

/**
 * `pos_order_settlements` — PLAN.md Phase 4. NOT in DATABASE.md's original
 * draft (which put one settlement's worth of columns directly on
 * `pos_orders`) — added in this pass because that shape can't express
 * "split a bill by item or evenly" (PRODUCT_REQUIREMENTS.md §3.4): a tab
 * settled partly by card and partly charged to a room is two records, not
 * one. See `20260912093000_create_pos_orders.js`'s own header for the full
 * reasoning; DATABASE.md is updated in this same pass.
 *
 * Scope: PROPERTY_SCOPED, following `pos_orders`.
 *
 * ── ONE ROW PER SETTLEMENT ATTEMPT, IMMUTABLE ONCE WRITTEN ───────────────
 *
 * Unlike `payments` (an async gateway state machine), a POS settlement in
 * this pass is always synchronous and final the moment it's recorded —
 * "cash", "card", and "contactless" are all the SAME `card` method here in
 * software: PRODUCT_REQUIREMENTS.md §3.4/§2 treats the card/contactless/
 * NQR distinction as a HARDWARE fact about the physical terminal (an NFC
 * reader vs. chip-only), not something this software layer processes
 * differently — the same reasoning already applied to
 * `pos_terminals.supports_contactless`. NQR/Flutterwave itself stays
 * unwired for the same reason Cashiering's own Paystack/Flutterwave split
 * already carries: no sandbox credentials exist in this environment.
 * `room_charge` is the one method that reaches real money infrastructure —
 * it posts a `pos_charge` line via the EXISTING `cashieringService.postCharge`
 * (already accepts `type: 'pos_charge'` — confirmed by reading that
 * function directly, zero changes needed there), so no separate `payments`
 * row is created for a POS sale at all; the guest pays their whole folio
 * later, at check-out, the same as every other room charge.
 *
 * `subtotal`/`tax_amount`/`tip_amount`/`service_charge` are stored
 * separately and never collapsed into a single "total" column — the same
 * "don't invent a second source of truth" reasoning `folios.balance`
 * follows, just applied to four immutable numbers instead of a mutable
 * running one. Void, never delete (ARCHITECTURE.md §8) — "post-settlement
 * voids require a manager PIN and are audited" (PRODUCT_REQUIREMENTS.md
 * §3.4's "Manager overrides"); this pass gates that on `pos.manage`
 * (this session's confirmed RBAC decision) rather than inventing a
 * separate PIN-re-entry mechanism this codebase has no other example of.
 *
 * `room_charge_auth_method`/`room_charge_auth_reference` are free strings,
 * not an enum — this session's confirmed decision: a property configures
 * which method it uses (signature/room_key/PIN, mirroring the door-lock
 * adapter picker's own free-string precedent), and the operator records a
 * short attestation at charge time. No signature-capture or key-card-
 * reader hardware integration exists in this pass — flagged, not silently
 * invented.
 *
 * `folio_line_item_id`/`tip_service_charge_line_item_id` carry no foreign
 * key, by design — the same polymorphic-reference precedent
 * `audit_log.entity_id`'s own header already sets: they exist so a
 * post-settlement void of a room-charge settlement can also void the
 * specific folio line(s) via the existing `cashieringService.voidLineItem`,
 * without this table needing a formal FK into a ledger it does not own.
 * The tip/service-charge amount posts as a SEPARATE, untaxed
 * `postAdjustment` line rather than being folded into the main charge's
 * own taxed base — a tip is not normally taxed, and this codebase's tax
 * engine has no mechanism to tax only part of one charge.
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
  await knex.schema.createTable('pos_order_settlements', (table) => {
    table.comment('One (possibly partial) settlement against a tab. Scope: PROPERTY_SCOPED. Void, never delete (ARCHITECTURE.md §8).');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('pos_order_id').unsigned().notNullable();

    table.integer('split_group').unsigned().nullable().comment('Which split group this settles — null when the whole order settles at once.');
    table.string('method', 20).notNullable().comment('cash | card | room_charge — see migration header for why contactless/NQR are not separate values.');

    table.decimal('subtotal', 12, 2).notNullable();
    table.decimal('tax_amount', 12, 2).notNullable().defaultTo('0.00');
    table.decimal('tip_amount', 12, 2).notNullable().defaultTo('0.00');
    table.decimal('service_charge', 12, 2).notNullable().defaultTo('0.00');
    table.string('currency', 3).notNullable();

    table.bigInteger('folio_id').unsigned().nullable().comment('Set only when method = room_charge.');
    table.bigInteger('folio_line_item_id').unsigned().nullable().comment('The posted pos_charge line — no FK, see migration header.');
    table
      .bigInteger('tip_service_charge_line_item_id')
      .unsigned()
      .nullable()
      .comment('The separate, untaxed adjustment line covering tip_amount+service_charge for a room_charge settlement, if either is nonzero — no FK, same reasoning as folio_line_item_id. Voided alongside folio_line_item_id when the settlement is voided, so a tip never survives as an orphaned adjustment.');
    table.string('room_charge_auth_method', 30).nullable().comment('signature | room_key | pin — free string, property-configured.');
    table.string('room_charge_auth_reference', 255).nullable().comment('Short operator attestation, e.g. "PIN entered" — never the PIN itself.');

    table.bigInteger('settled_by_user_id').unsigned().notNullable();
    table.datetime('settled_at').notNullable().defaultTo(knex.fn.now());

    table.datetime('voided_at').nullable();
    table.string('void_reason', 255).nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'pos_order_settlements_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'pos_order_settlements_tenant_id_property_id_order_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'folio_id'], 'pos_order_settlements_tenant_id_property_id_folio_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('folios')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'settled_by_user_id'], 'pos_order_settlements_tenant_id_settled_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'pos_order_settlements_tenant_id_voided_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'pos_order_id'], 'pos_order_settlements_tenant_id_property_id_order_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_order_settlements');
};
