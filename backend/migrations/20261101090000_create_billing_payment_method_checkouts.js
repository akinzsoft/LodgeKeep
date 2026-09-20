'use strict';

/**
 * `billing_payment_method_checkouts` — security fix (2026-11-01).
 *
 * A security review found `completeAddPaymentMethod`
 * (`src/modules/billing/service.js`) trusted a client-supplied `reference`
 * outright: it called Paystack's own `/transaction/verify` and, as long as
 * that call came back `status: 'success'` with a reusable authorization,
 * attached whatever card it returned to the caller's tenant — with nothing
 * checking that the reference belonged to a checkout THIS tenant actually
 * started, nor that the verified amount/currency/email matched what was
 * expected. A caller with `billing.manage` on any tenant (trivially
 * obtained via self-service signup) could submit a reference for ANY
 * successful Paystack transaction on the platform's billing account —
 * including one belonging to a stranger — and have that stranger's card
 * authorization silently attached to their own tenant's subscription.
 *
 * This table is the missing "intended checkout" record ARCHITECTURE.md §7
 * already requires for every other real payment flow in this codebase
 * (`payments`/`subscription_payments` both insert a local intent row
 * BEFORE the gateway is ever called): `startAddPaymentMethodCheckout`
 * inserts one row here, `pending`, before asking Paystack to initialize
 * the transaction; `completeAddPaymentMethod` looks the reference up
 * SCOPED TO THE CALLER'S OWN TENANT (so a reference belonging to a
 * different tenant simply does not resolve — the same 404-not-403 shape
 * every other cross-tenant lookup in this codebase already uses), checks
 * the gateway's verified amount/currency against what was recorded at
 * initiation, and claims the row with a conditional UPDATE
 * (`WHERE status = 'pending'`) so the SAME reference can never be
 * "completed" twice — replay protection, not just ownership.
 *
 * Scope: PLATFORM_SCOPED with `tenant_id` an `unscopedColumns` mandatory
 * business column, following `subscriptions`/`subscription_payments`
 * exactly (real, known-at-creation data, not scope-column attribution).
 * Reached only through hand-written queries in
 * `src/modules/billing/service.js`, never the accessor's generic `table()`
 * path.
 *
 * `expires_at` — re-review finding (before this migration ever merged, so
 * fixed here directly rather than as a follow-up ALTER, matching this
 * codebase's own established convention): the original version of this
 * table had no expiry at all — a `pending` checkout row, and the real
 * Paystack reference it names, stayed completable indefinitely.
 * `startAddPaymentMethodCheckout` sets this to
 * `BILLING_CHECKOUT_EXPIRY_MINUTES` (default 30) minutes out;
 * `completeAddPaymentMethod` rejects a completion attempt past it
 * (`CheckoutExpiredError`) and folds the same condition into its atomic
 * claim's own `WHERE` clause as a defense-in-depth guard against the
 * narrow window between that read and the claim. No sweep transitions a
 * row to the `expired` status value once it lapses — that value is read
 * (checked against, not just written), so "enforced" here means
 * "rejected past its own recorded deadline," not "actively relabeled";
 * a future cleanup sweep can still use it for that, unbuilt.
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
  await knex.schema.createTable('billing_payment_method_checkouts', (table) => {
    table.comment(
      'One row per add/replace-payment-method checkout attempt, recorded BEFORE the gateway is called — the ownership/replay record completeAddPaymentMethod verifies against. Scope: PLATFORM_SCOPED, tenant_id mandatory (unscoped, not attribution).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table.string('reference', 100).notNullable().comment('Our own generated reference (matches subscription_payments.provider_reference\'s own shape), passed to Paystack and how completion looks this row up.');
    table.string('email', 320).notNullable();
    table.decimal('amount', 12, 2).notNullable();
    table.string('currency', 3).notNullable();

    table
      .enu('status', ['pending', 'consumed', 'expired'])
      .notNullable()
      .defaultTo('pending')
      .comment('"consumed" claimed by a conditional UPDATE in completeAddPaymentMethod — the replay guard. Nothing transitions a row to "expired" yet; the value exists for a future cleanup sweep, matching this codebase\'s own precedent of naming a status before the job that sets it is built.');

    table
      .datetime('expires_at')
      .notNullable()
      .comment('Set at checkout-start time (BILLING_CHECKOUT_EXPIRY_MINUTES minutes out, default 30) — completeAddPaymentMethod rejects any completion attempt past this, and folds the same condition into its atomic claim UPDATE.');

    timestamps(knex, table);

    table.unique(['reference'], { indexName: 'billing_payment_method_checkouts_reference_unique' });
    table.index(['tenant_id', 'reference'], 'billing_payment_method_checkouts_tenant_id_reference_index');

    table
      .foreign('tenant_id', 'billing_payment_method_checkouts_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('billing_payment_method_checkouts');
};
