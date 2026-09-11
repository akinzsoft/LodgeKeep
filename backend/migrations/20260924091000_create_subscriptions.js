'use strict';

/**
 * `subscriptions` — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22
 * ("Subscription billing: recurring charges to the tenant... payment
 * method on file... build the billing processor as a pluggable adapter").
 * DATABASE.md's own draft row for this table, made real.
 *
 * Scope: PLATFORM_SCOPED with `tenant_id` an `unscopedColumns` mandatory
 * business column — following `impersonation_sessions`/`tenant_signups`'
 * own precedent exactly, for the identical reason: this is Planmsys'
 * relationship with the TENANT itself (never a property — a tenant may run
 * several properties in several currencies; Planmsys bills the tenant,
 * not any one of them), reached only through hand-written queries in
 * `src/modules/billing/service.js`, never the accessor's generic scoped
 * `table()` path.
 *
 * ── ONE ROW PER TENANT, NO HISTORY (this pass's own scope boundary) ─────
 *
 * `UNIQUE(tenant_id)` — a tenant has at most one subscription, updated in
 * place as its billing period rolls over. Plan upgrades/downgrades and
 * cancel-then-resubscribe flows (which WOULD need real history) are
 * explicitly out of this pass's scope; `subscription_invoices` is the
 * per-period ledger, not this row.
 *
 * ── `status` IS A BILLING-HEALTH SIGNAL, NOT THE TENANT'S OPERATIONAL
 *    ACCESS STATE ────────────────────────────────────────────────────────
 *
 * `tenants.status` (`trial`/`active`/`suspended`/`offboarding`,
 * `src/shared/tenant-lifecycle.js`) is left completely unchanged by this
 * pass — no new enum value, no touched enforcement logic. `active` here
 * only means "this tenant has a confirmed, chargeable payment method and
 * an open subscription" — a tenant can be `subscriptions.status = 'active'`
 * while `tenants.status` is still `'trial'` (a payment method was added
 * during the trial, ahead of conversion) or already `'active'` (the
 * ordinary case once converted). `past_due` means a charge attempt has
 * failed and dunning is in progress — the tenant's OWN `tenants.status`
 * stays `'active'` throughout dunning (a grace period, per
 * PRODUCT_REQUIREMENTS.md §3.22's "read-only degradation with a grace
 * period is safer than a hard cutoff"); only once retries exhaust does
 * `src/jobs/subscription-billing.js` flip `tenants.status` to `'suspended'`
 * directly (the same raw-`knex()`-conditional-UPDATE mechanism
 * `src/jobs/trial-expiry.js` already established, not a call into
 * `platform/service.js`'s `suspendTenant`, which structurally cannot be
 * invoked by a job — see that file's own header). `canceled` is reachable
 * only by a future offboarding flow (out of this pass's scope) — no code
 * transitions into it yet.
 *
 * ── PAYMENT METHOD — TOKENISED, NEVER RAW CARD DATA ─────────────────────
 *
 * `payment_method_authorization_code` is the gateway's own reusable charge
 * token (Paystack's `authorization_code` — itself useless to charge
 * without our own secret key, the same "opaque provider reference" shape
 * `payments.provider_payment_id` already uses elsewhere in this schema,
 * not a new class of secret needing encryption at rest). `last4`/`brand`/
 * `exp_month`/`exp_year` are DISPLAY metadata only (Paystack's own
 * authorization object already returns these) — never the PAN, never the
 * CVV, matching ARCHITECTURE.md's "tokenised, never raw card data" rule
 * for guest payments applied identically here.
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
  await knex.schema.createTable('subscriptions', (table) => {
    table.comment(
      'The Planmsys billing relationship with one tenant — one row per tenant, no history this pass. Scope: PLATFORM_SCOPED, tenant_id mandatory (unscoped, not attribution).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('plan_id').unsigned().notNullable();

    table
      .enu('status', ['active', 'past_due', 'canceled'])
      .notNullable()
      .defaultTo('active')
      .comment('Billing health, not the tenant\'s own operational access state — see migration header.');

    table.date('current_period_start').notNullable();
    table.date('current_period_end').notNullable();

    table.string('payment_method_provider', 30).nullable().comment('"paystack" — free string, matching payments.provider\'s own gateway-agnostic reasoning.');
    table.string('payment_method_authorization_code', 100).nullable().comment('The gateway\'s own reusable charge token — opaque, never the PAN. See migration header.');
    table.string('payment_method_last4', 4).nullable();
    table.string('payment_method_brand', 30).nullable();
    table.integer('payment_method_exp_month').unsigned().nullable();
    table.integer('payment_method_exp_year').unsigned().nullable();

    table.integer('consecutive_failed_attempts').unsigned().notNullable().defaultTo(0).comment('Reset to 0 on any successful charge. Drives the dunning schedule in src/modules/billing/service.js.');

    timestamps(knex, table);

    table.unique(['tenant_id'], { indexName: 'subscriptions_tenant_id_unique' });
    // Composite parent key — DATABASE.md §2's rule: a table another
    // PLATFORM_SCOPED-with-real-tenant_id table (subscription_invoices)
    // needs to reference by BOTH tenant_id and id together needs this,
    // the same reason `roles`/`users`/`properties` each carry one.
    table.unique(['tenant_id', 'id'], { indexName: 'subscriptions_tenant_id_id_unique' });

    table
      .foreign('tenant_id', 'subscriptions_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign('plan_id', 'subscriptions_plan_id_foreign')
      .references('id')
      .inTable('plans')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['status', 'current_period_end'], 'subscriptions_status_current_period_end_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('subscriptions');
};
