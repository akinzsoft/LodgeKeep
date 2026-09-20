'use strict';

/**
 * `platform_payment_integrations` — gap closure: guest card payments have,
 * since Phase 2.5, all settled into ONE Paystack merchant account (ours),
 * regardless of which tenant/property the folio belongs to — confirmed a
 * real, not-viable defect (a hotel's own room revenue must reach the
 * hotel, not Planmsys). Two approaches were researched and compared
 * (per-tenant API keys vs. Paystack Subaccounts/split payments); Paystack
 * Subaccounts under our own single merchant account was the confirmed
 * choice — lower onboarding friction (a hotel supplies a bank account, not
 * a whole separate Paystack merchant relationship), a materially smaller
 * change to the existing cashiering code, and it is the only one of the
 * two that lets the platform take a fee at all.
 *
 * ── WHY THIS TABLE EXISTS AT ALL, RATHER THAN JUST WIDENING
 * `PAYSTACK_SECRET_KEY` ────────────────────────────────────────────────
 *
 * Confirmed live against the real Paystack sandbox before this was
 * designed: a Paystack merchant integration is scoped to exactly ONE
 * settlement currency (`POST /transaction/initialize` with `currency:
 * "GHS"` against our own NGN-only integration returned a real
 * `403 unsupported_currency` — and, more importantly, that check happens
 * BEFORE a subaccount is even looked up, proven by a fake subaccount code
 * still failing on currency first). A subaccount can never carry a
 * transaction in a currency its own parent integration is not enabled
 * for — it inherits the parent's currency, it does not carry its own.
 *
 * International expansion is a confirmed real future goal (not
 * near-term), so rather than hardcode "one platform Paystack key" as a
 * singleton the way `BILLING_PAYSTACK_SECRET_KEY` correctly is for
 * subscription billing (a genuinely separate, single, Planmsys-own
 * merchant relationship — untouched by this migration), this is a small
 * catalogue: one row per settlement country/currency. Adding a second
 * country later is a DATA change (insert one more row, e.g. Ghana/GHS
 * with its own Paystack merchant credentials) rather than a schema
 * change or a rework of how a property's payment integration is resolved
 * — `property_payment_subaccounts.platform_payment_integration_id`
 * (next migration) already references this table, even though only one
 * row exists today.
 *
 * Scope: GLOBAL_REFERENCE, mirroring `plans` exactly — a shared, seeded,
 * tenant-independent catalogue no tenant edits through the accessor
 * (ARCHITECTURE.md §3). `currency` is UNIQUE — "which integration does
 * this property's payment route through" is always resolved by the
 * property's own `base_currency`, never a stored id a later reseed could
 * leave dangling.
 *
 * No UI is built to manage this catalogue in this pass — user-confirmed
 * decision ("don't build a UI for managing multiple integrations yet —
 * one NGN row, created at deploy. That's the part worth deferring."). This
 * migration itself IS "created at deploy": it seeds the one NGN row by
 * reading `process.env.PAYSTACK_SECRET_KEY` at migration-run time,
 * mirroring `plans`' own migration seeding its one row inline. If that
 * env var is absent (a test/CI environment with no real credentials —
 * the same environment every pre-existing Paystack-gated test already
 * skips against), the insert is simply skipped rather than failing the
 * migration — a property resolving no integration for its currency then
 * gets the same `PAYMENT_GATEWAY_NOT_CONFIGURED` shape guest card
 * payments have always used for "no credentials in this environment."
 *
 * `secret_key_encrypted` is genuinely encrypted at rest
 * (`src/shared/encryption.js`, AES-256-GCM) — the same treatment
 * `email_settings.smtp_password_encrypted` already established for this
 * schema's first real secret; this is its second.
 */

const { encrypt } = require('../src/shared/encryption');

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('platform_payment_integrations', (table) => {
    table.comment(
      'One row per guest-payment settlement country/currency Planmsys operates a Paystack merchant integration under. Scope: GLOBAL_REFERENCE — seeded, read-only through the accessor, same as `plans`.'
    );

    table.bigIncrements('id');

    table.string('provider', 30).notNullable().defaultTo('paystack').comment('Free string, matching payments.provider — a future non-Paystack provider needs no schema change.');
    table.string('country', 2).notNullable().comment('ISO 3166-1 alpha-2, e.g. "NG" — informational, matching the merchant integration this credential belongs to.');
    table
      .string('currency', 3)
      .notNullable()
      .unique('platform_payment_integrations_currency_unique')
      .comment('ISO 4217 — the resolution key. A property resolves its own integration via properties.base_currency, never a stored id.');

    table.text('secret_key_encrypted', 'text').notNullable().comment('AES-256-GCM ciphertext (src/shared/encryption.js) — never plaintext. This merchant integration\'s own secret key.');

    table.boolean('is_active').notNullable().defaultTo(true).comment('A deactivated row is never resolved for a new charge — the same "flag rather than delete" discipline reference data in this schema already uses.');

    timestamps(knex, table);
  });

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (secretKey) {
    await knex('platform_payment_integrations').insert({
      provider: 'paystack',
      country: 'NG',
      currency: 'NGN',
      secret_key_encrypted: encrypt(secretKey),
      is_active: true,
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('platform_payment_integrations');
};
