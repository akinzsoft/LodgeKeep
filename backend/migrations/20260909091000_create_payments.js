'use strict';

/**
 * `payments` — PLAN.md Phase 2.5 (Cashiering's real ledger, step 2:
 * "Payment integration"), ARCHITECTURE.md §7 (the full state machine and
 * field set), DATABASE.md §1's own row for this table.
 *
 * Scope: PROPERTY_SCOPED, following `folios` (its parent) for the same
 * reason every folio-adjacent table has since Phase 2: two properties in
 * the same tenant have entirely different guests, folios, and payments.
 *
 * ── THE STATE MACHINE (ARCHITECTURE.md §7) ──────────────────────────────
 *
 * `INITIATED -> PENDING -> AUTHORIZED -> CAPTURED`, with `FAILED`/`EXPIRED`
 * branches off the pending path, `AUTHORIZED -> VOIDED`,
 * `CAPTURED -> REFUNDED`/`PARTIALLY_REFUNDED`, and `CANCELLED` reachable
 * from any non-terminal state. A module must never invent an ad hoc status
 * string outside this exact enum — see `src/modules/cashiering/service.js`'s
 * own transition guard.
 *
 * `idempotency_key` is a SEPARATE, DEFENSE-IN-DEPTH mechanism from the
 * generic `idempotency_keys` table (Phase 2, `src/shared/idempotency.js`):
 * that one replays a stored HTTP RESPONSE at the controller layer; this
 * column means the `payments` table itself is provably idempotent — one row
 * per client-supplied key — even for a write that reaches this table
 * through a path other than the HTTP controller (a webhook handler, an
 * internal service call). `UNIQUE(tenant_id, idempotency_key)`, matching
 * DATABASE.md §1's explicit column list for this table.
 *
 * `parent_payment_id` self-references this same table (a refund links back
 * to what it refunds) — the first self-referencing FK in this schema, and
 * the first PROPERTY_SCOPED table to reference ANOTHER PROPERTY_SCOPED row
 * of its OWN table, so this migration also adds this table's own 3-column
 * composite parent key (DATABASE.md §2's rule, same as `folios`' own
 * migration in this pass) in order to declare the self-referencing FK at
 * all.
 *
 * `provider` is a free string, not an enum — DATABASE.md's own note:
 * "gateway-agnostic (3.15)". This pass wires `cash` (no external gateway —
 * capture is synchronous, real, no stub) and `paystack` (a real sandbox
 * integration — `src/modules/cashiering/paystack-adapter.js`) with
 * `flutterwave` NOT wired (PRODUCT_REQUIREMENTS.md §3.5 names it; no
 * sandbox credentials exist in this environment for it, and an enum would
 * force a schema change to add it later for no reason a free string avoids).
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
  await knex.schema.createTable('payments', (table) => {
    table.comment(
      'One payment/refund attempt against a folio, per the state machine in ARCHITECTURE.md section 7. Scope: PROPERTY_SCOPED. Immutable except the status/timestamp fields the state machine itself moves.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('folio_id').unsigned().notNullable();

    table
      .string('idempotency_key', 191)
      .notNullable()
      .comment('Defense-in-depth beyond the generic idempotency_keys table — see migration header.');

    table.string('provider', 30).notNullable().comment('"cash" (real, synchronous) or "paystack" (real sandbox integration). See migration header.');
    table.string('provider_payment_id', 100).nullable().comment('The gateway\'s own transaction id, filled in once known (verify/webhook) — null for cash.');
    table
      .string('provider_reference', 100)
      .notNullable()
      .comment('Our own generated reference (a ULID), passed to the gateway as its "reference" — also how a webhook is matched back to this row.');

    table.decimal('amount', 12, 2).notNullable().comment('Always positive — sign/direction is implied by type (payment vs refund), matching folio_line_items\' own signed convention.');
    table.string('currency', 3).notNullable();

    table
      .enu('status', [
        'INITIATED',
        'PENDING',
        'AUTHORIZED',
        'CAPTURED',
        'FAILED',
        'EXPIRED',
        'VOIDED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
        'CANCELLED',
      ])
      .notNullable()
      .defaultTo('INITIATED')
      .comment('ARCHITECTURE.md section 7\'s exact state machine — no ad hoc status strings.');

    table.string('failure_code', 100).nullable();
    table.string('failure_reason', 500).nullable();

    table.datetime('authorized_at').nullable();
    table.datetime('captured_at').nullable();
    table.datetime('failed_at').nullable();
    table.datetime('expired_at').nullable();

    table
      .bigInteger('parent_payment_id')
      .unsigned()
      .nullable()
      .comment('Links a refund back to the payment it refunds (ARCHITECTURE.md section 7). Null for an original payment.');

    timestamps(knex, table);

    table.unique(['tenant_id', 'idempotency_key'], { indexName: 'payments_tenant_id_idempotency_key_unique' });
    table.unique(['provider', 'provider_reference'], { indexName: 'payments_provider_provider_reference_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'payments_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'payments_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'folio_id'], 'payments_tenant_id_property_id_folio_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('folios')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'parent_payment_id'], 'payments_tenant_id_property_id_parent_payment_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('payments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'folio_id'], 'payments_tenant_id_property_id_folio_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('payments');
};
