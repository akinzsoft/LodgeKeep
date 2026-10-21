'use strict';

/**
 * Per-tenant app domain + manually-paid subscriptions.
 *
 *   tenants.app_domain      which accepted domain this tenant's outgoing links use (trial = the old domain, subscribed = the
 *                           new one). Backfilled with TRIAL_APP_DOMAIN on EVERY existing tenant, whatever its status: nobody
 *                           changes domain at deploy; the operator moves a tenant later, on purpose, from the console.
 *                           TRIAL_APP_DOMAIN MUST be set (and be an accepted domain): the migration FAILS, before changing
 *                           anything, rather than falling back to the primary, so a missing variable cannot silently
 *                           misplace tenants. Never left NULL, so a later change of PRIMARY_APP_DOMAIN cannot move anyone.
 *                           No email is sent by this migration.
 *   tenants.subscribed_at   when the tenant was first marked subscribed (null = never), so a first subscription can be told
 *                           apart from a reactivation after a suspension.
 *   tenant_lifecycle_emails one row per (tenant, kind, user) the platform has e-mailed about a lifecycle event; the UNIQUE key
 *                           is the idempotency guard (inserted in the same transaction as the outbox event).
 *   manual_payment_records  how a manually-paid (cash / bank transfer / other) subscription payment was made. The money itself
 *                           is an ordinary subscription_invoices + subscription_payments row (provider 'manual'); this holds
 *                           only what those tables have no column for. Kept after a purge, like the billing records it extends.
 *
 * Both new tables are PLATFORM_SCOPED with a mandatory tenant_id (like subscriptions). No pos_*, payments, folio or
 * discount table is touched.
 */

const { appDomains, normaliseDomain } = require('../src/shared/app-domains');

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

/** The explicit TRIAL_APP_DOMAIN, or a loud failure. No fallback to the primary. */
function requireTrialDomain(env = process.env) {
  const raw = String(env.TRIAL_APP_DOMAIN ?? '').trim();
  if (!raw) {
    throw new Error('TRIAL_APP_DOMAIN is not set. This migration writes it onto every existing tenant (the OLD domain) and will not guess; set it to the domain tenants use today, then run the migration again. Nothing was changed.');
  }
  const domain = normaliseDomain(raw, 'TRIAL_APP_DOMAIN');
  if (!appDomains(env).all.includes(domain)) {
    throw new Error(`TRIAL_APP_DOMAIN (${domain}) is not one of the accepted app domains (PRIMARY_APP_DOMAIN / ADDITIONAL_APP_DOMAINS). Nothing was changed.`);
  }
  return domain;
}

/** Every tenant, whatever its status, gets the same explicit domain. Status plays no part. */
async function backfillAppDomain(knex, domain) {
  return knex('tenants').update({ app_domain: domain });
}

exports.up = async function up(knex) {
  const trialDomain = requireTrialDomain(); // first, before any schema change

  await knex.schema.alterTable('tenants', (table) => {
    table.string('app_domain', 253).nullable().comment('The accepted app domain this tenant is reached at in outgoing mail. Null = the primary domain.');
    table.datetime('subscribed_at').nullable().comment('When the tenant was first marked subscribed. Null = never.');
  });

  await backfillAppDomain(knex, trialDomain);

  await knex.schema.createTable('tenant_lifecycle_emails', (table) => {
    table.comment('One row per user the platform e-mailed about a tenant lifecycle event; UNIQUE(tenant, kind, user) is the idempotency guard. Scope: PLATFORM_SCOPED, tenant_id mandatory.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.string('kind', 60).notNullable().comment('trial_started | subscribed | renewal:<paid_until>');
    table.bigInteger('user_id').unsigned().notNullable();
    table.bigInteger('outbox_event_id').unsigned().nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['tenant_id', 'kind', 'user_id'], { indexName: 'tenant_lifecycle_emails_unique' });
    table.foreign('tenant_id', 'tenant_lifecycle_emails_tenant_foreign').references('id').inTable('tenants').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'user_id'], 'tenant_lifecycle_emails_user_foreign').references(['tenant_id', 'id']).inTable('users').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });

  await knex.schema.createTable('manual_payment_records', (table) => {
    table.comment('How a manually-paid subscription payment was made (the money is a subscription_payments row, provider manual). Scope: PLATFORM_SCOPED, tenant_id mandatory.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('subscription_payment_id').unsigned().notNullable();
    table.bigInteger('plan_id').unsigned().notNullable();
    table.string('kind', 12).notNullable().comment('subscribe | renewal');
    table.string('method', 20).notNullable().comment('cash | bank_transfer | other');
    table.string('reference_note', 200).notNullable();
    table.date('paid_until').notNullable();
    table.bigInteger('recorded_by_platform_user_id').unsigned().nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['subscription_payment_id'], { indexName: 'manual_payment_records_payment_unique' });
    table.index(['tenant_id', 'paid_until'], 'manual_payment_records_tenant_paid_until_index');
    table.foreign('tenant_id', 'manual_payment_records_tenant_foreign').references('id').inTable('tenants').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'subscription_payment_id'], 'manual_payment_records_payment_foreign').references(['tenant_id', 'id']).inTable('subscription_payments').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign('plan_id', 'manual_payment_records_plan_foreign').references('id').inTable('plans').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('manual_payment_records');
  await knex.schema.dropTableIfExists('tenant_lifecycle_emails');
  await knex.schema.alterTable('tenants', (table) => {
    table.dropColumn('subscribed_at');
    table.dropColumn('app_domain');
  });
};

exports.requireTrialDomain = requireTrialDomain;
exports.backfillAppDomain = backfillAppDomain;
