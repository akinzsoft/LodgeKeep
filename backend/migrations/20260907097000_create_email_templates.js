'use strict';

/**
 * Per-tenant, per-property branded email templates — PLAN.md Phase 3,
 * PRODUCT_REQUIREMENTS.md §3.21: "per-property branded (logo, colours, hotel
 * name), and template content editable by an admin without a code deploy."
 *
 * Scope: PROPERTY_SCOPED — two properties in the same tenant can want
 * different branding/copy for the same `template_key` (a chain with two
 * distinctly-branded hotels), the same reasoning `taxes`/`rate_codes` gave
 * in Phase 1.
 *
 * `template_key` is a short fixed vocabulary this pass emits against
 * (`reservation_confirmed`, `reservation_cancelled`, `checked_in`,
 * `checked_out`) — PRODUCT_REQUIREMENTS.md §3.21 lists a longer eventual set
 * (pre-arrival, staff invitation, password reset, ...), most of which have
 * no triggering module yet in this pass and are deliberately not seeded
 * ahead of one, the same "the catalogue arrives one key at a time" discipline
 * `permissions` already follows.
 *
 * No default row is seeded for any property here: a template with no row
 * yet is a real, visible "not configured" state (`src/modules/notifications`
 * falls back to a minimal built-in default body so a send is never silently
 * dropped for want of a template), not filled with an invented default that
 * would need updating everywhere the moment a tenant edits it.
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
  await knex.schema.createTable('email_templates', (table) => {
    table.comment('A per-property, admin-editable email template. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.string('template_key', 60).notNullable();
    table.string('locale', 10).notNullable().defaultTo('en');
    table.string('subject', 255).notNullable();
    table.text('body_html', 'mediumtext').notNullable();

    timestamps(knex, table);

    // DATABASE.md §2: one template per (property, key, locale).
    table.unique(['property_id', 'template_key', 'locale'], {
      indexName: 'email_templates_property_id_template_key_locale_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'email_templates_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_templates');
};
