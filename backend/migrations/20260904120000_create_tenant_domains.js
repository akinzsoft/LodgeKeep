'use strict';

/**
 * tenant_domains — PRODUCT_REQUIREMENTS.md §3.16's login redesign.
 *
 * §3.16 (updated in this pass): staff login resolves `tenant_id` from the
 * request's `Host` header *before any query runs* — either the default
 * `{slug}.lodgekeep.app` subdomain (resolved straight off `tenants.slug`, no
 * new table needed) or a tenant's own custom domain, which needs somewhere to
 * live. This table is that somewhere.
 *
 * The reasoning that makes Host-header resolution necessary in the first place:
 * `users.email` is unique per tenant, not globally (`users_tenant_id_email_unique`
 * — the fixtures deliberately seed the same address in two tenants to prove
 * this), so a login request carrying only `{ email, password }` cannot resolve
 * a tenant without either an unscoped scan across every tenant's users (exactly
 * the query shape SECURITY.md §2 exists to forbid) or a second signal. The registered
 * domain the request arrived on is that signal, and it is one MySQL can enforce
 * uniqueness on natively, unlike an email address.
 *
 * Scope: TENANT_SCOPED. A domain belongs to exactly one tenant, and — like
 * `tenants` itself — is looked up *before* a request context exists, which is
 * why the accessor's bootstrap path (`src/modules/tenancy/scoped-db.js`,
 * `bootstrapLookup`) is the only way either table is read at this point in a
 * request. See that file for why this is a deliberate, narrow exception to
 * "every read goes through the scoped accessor" rather than a hole in it.
 *
 * Verification (DNS TXT challenge or equivalent, so a tenant cannot claim a
 * domain it does not control) is out of scope here — `verified_at` is nullable
 * and unused until that workflow exists, almost certainly alongside billing/plan
 * tier work in a later phase. An unverified domain still resolves for Phase 0
 * so local/staging environments can exercise the code path; production
 * enforcement of "verified only" is a one-line change to the resolution query
 * once that workflow lands, not a schema change.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('tenant_domains', (table) => {
    table.comment(
      'Custom domains a tenant logs in from, resolved to tenant_id before any authenticated query runs. Scope: TENANT_SCOPED. Read through the accessor bootstrap path only — see scoped-db.js.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table
      .string('domain', 255)
      .notNullable()
      .comment('Fully-qualified host, e.g. "book.alpha-hotels-group.com" for a tenant whose default subdomain is alpha-hotels.APP_DOMAIN. Global UNIQUE below is what makes Host-header resolution safe: two tenants can never register the same domain.');

    table
      .datetime('verified_at')
      .nullable()
      .comment('NULL until domain ownership is proven (DNS TXT challenge or equivalent — not built yet). Unenforced in Phase 0; see file header.');

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table
      .datetime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    // Global, not per-tenant — a domain names one tenant by construction, the
    // same reasoning `sessions.refresh_token_hash` and `tenants.slug` follow.
    table.unique(['domain'], { indexName: 'tenant_domains_domain_unique' });

    table
      .foreign('tenant_id', 'tenant_domains_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id'], 'tenant_domains_tenant_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tenant_domains');
};
