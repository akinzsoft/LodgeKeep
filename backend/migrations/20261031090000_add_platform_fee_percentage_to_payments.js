'use strict';

/**
 * `payments.platform_fee_percentage` — gap closure for the new payment
 * reconciliation report (`src/modules/reconciliation`). Confirmed decision
 * (AskUserQuestion): snapshot the fee at charge time rather than resolve it
 * live against `property_payment_subaccounts.percentage_charge` — that
 * column is a mutable per-property config value an admin can change at any
 * time with no other event forcing a review of who's affected, the exact
 * shape ARCHITECTURE.md §12 already requires be captured historically for
 * tax ("always calculated against the version effective on the charge's
 * business_date... a folio audited six months later reproduces the same
 * numbers"). This is the identical reasoning `payments.subaccount_code`
 * (migration `20261029092000`) already established for the sibling column
 * on this same mutable config row — that migration's own header states
 * plainly why re-deriving it later is wrong; this column closes the
 * matching gap for the fee percentage itself.
 *
 * Nullable: every payment made before this migration (and every cash
 * payment, which never resolves a subaccount at all) has no value here.
 * The reconciliation report treats a null the same as `0.00` — "no
 * platform fee was in effect for/recorded against this payment" — never a
 * crash or a fabricated non-zero figure.
 *
 * Stamped in the SAME code path that already stamps `subaccount_code`
 * (`startPaystackCheckout`, `src/modules/cashiering/service.js`) — reading
 * `subaccountRow.percentage_charge` from the exact same row already being
 * read for `subaccountRow.subaccount_code`, not a second query.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table
      .decimal('platform_fee_percentage', 5, 2)
      .nullable()
      .comment(
        'Snapshot of property_payment_subaccounts.percentage_charge at the moment this payment was checked out — never re-derived later. Null for cash, and for any paystack payment made before this column existed.'
      );
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table.dropColumn('platform_fee_percentage');
  });
};
