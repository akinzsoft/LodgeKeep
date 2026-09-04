'use strict';

/**
 * Guests — PLAN.md Phase 2's reservations module needs a guest to point a
 * reservation at; DATABASE.md §1: "`guest_id` references the tenant-level
 * `guests` row regardless of which property this reservation is for — the
 * guest's identity doesn't change per property." `guest_accounts`
 * (20260903202134_create_identity_and_access) already carries a nullable,
 * FK-less `guest_id` column with its own comment saying exactly this: "The
 * tenant-level guests row this login belongs to. FK added with the guests
 * table in Phase 2." This migration is that Phase 2, and adds that FK below.
 *
 * Scope: TENANT_SCOPED — confirmed twice over (that guest_accounts comment,
 * and DATABASE.md's own line above), not PROPERTY_SCOPED like
 * `guest_accounts` itself: a guest is one person across every property a
 * tenant operates, even though where they log in to the portal is
 * necessarily property-specific.
 *
 * Deliberately minimal (this session's confirmed scope decision): name,
 * email, phone — enough to identify who a reservation is for. NOT full
 * Guest Profiles (PRODUCT_REQUIREMENTS.md §3.1) — no search index beyond
 * what a plain query already gives, no stay-history rollup, no loyalty
 * fields. A later Guest Profiles pass extends this table; it does not
 * replace it.
 *
 * `status` takes DATABASE.md §3's full documented lifecycle
 * (`active -> merged -> anonymised`) as an enum even though this pass only
 * ever writes `active` — the same reasoning `rooms.status` and
 * `properties`-adjacent enums in Phase 1 already used: widening an enum
 * value list later is backwards-compatible, so stating the eventual
 * vocabulary now costs nothing. The merge/anonymise MECHANISMS (which
 * record survives a merge, how anonymisation blanks personal fields while
 * preserving folio/reservation history per DATABASE.md's GDPR/NDPA note)
 * are real features with their own audit trail requirements and are not
 * built here — a `merged_into_guest_id` column would be meaningless without
 * that mechanism behind it, so it is not added speculatively.
 *
 * No UNIQUE constraint: two guests legitimately share an email (a family
 * booking under one address) or a phone, and a guest may have neither if
 * only a name was taken at the desk. Nothing here is a natural key.
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
  await knex.schema.createTable('guests', (table) => {
    table.comment(
      'A tenant-level guest identity a reservation is booked for. Scope: TENANT_SCOPED. Never hard-deleted — anonymise in place per DATABASE.md section 3 GDPR/NDPA note, not delete.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table.string('first_name', 100).notNullable();
    table.string('last_name', 100).notNullable();
    table.string('email', 255).nullable();
    table.string('phone', 30).nullable();

    table
      .enu('status', ['active', 'merged', 'anonymised'])
      .notNullable()
      .defaultTo('active')
      .comment('DATABASE.md section 3\'s full documented lifecycle. Only "active" is written by this pass — see file header.');

    timestamps(knex, table);

    table
      .foreign('tenant_id', 'guests_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'status'], 'guests_tenant_id_status_index');

    // Parent key for reservations.guest_id's 2-column FK below, and for
    // guest_accounts.guest_id's below — InnoDB needs the referenced columns
    // to be the leftmost prefix of an index on the parent (the same reason
    // properties_tenant_id_id_unique exists on `properties`).
    table.unique(['tenant_id', 'id'], { indexName: 'guests_tenant_id_id_unique' });
  });

  // The forward-reference guest_accounts.guest_id has been waiting for this
  // table since Phase 0 (see that migration's own comment on the column).
  // (tenant_id, tenant_id+guest_id) index guest_accounts already carries
  // (guest_accounts_tenant_id_guest_id_index) satisfies InnoDB's requirement
  // that a FK's referencing columns be indexed, so only the constraint
  // itself is added here.
  await knex.schema.alterTable('guest_accounts', (table) => {
    table
      .foreign(['tenant_id', 'guest_id'], 'guest_accounts_tenant_id_guest_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('guests')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('guest_accounts', (table) => {
    table.dropForeign(['tenant_id', 'guest_id'], 'guest_accounts_tenant_id_guest_id_foreign');
  });
  await knex.schema.dropTableIfExists('guests');
};
