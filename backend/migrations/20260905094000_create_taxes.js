'use strict';

/**
 * Taxes — PLAN.md Phase 1 ("tax configuration, effective-dated"),
 * ARCHITECTURE.md §12.1 (full field list and the historical-reproducibility
 * rule), DATABASE.md §1 ("taxes | tax_code, name, rate, applies_to,
 * effective_from, effective_to, inclusive_or_exclusive, calculation_method,
 * priority, is_compound, rounding_method, jurisdiction | Effective-dated —
 * never rewrites historical folios").
 *
 * Scope: PROPERTY_SCOPED.
 *
 * ── THE EFFECTIVE-DATING SHAPE, AND WHY IT HAS NO PRECEDENT TO COPY ────────
 *
 * No earlier migration in this schema models effective-dated data — this is
 * the first. ARCHITECTURE.md §12.1's own rule: "changing a tax rate must
 * never alter what a historical folio's tax lines say ... always calculating
 * against the tax version effective on the charge's business_date." A "tax
 * rate change" is therefore never an UPDATE to an existing row's `rate` —
 * it is a NEW row with its own `effective_from`, with the row it supersedes
 * getting its `effective_to` closed out. Both writes happen in the setup
 * module's service layer, inside one transaction; nothing here enforces that
 * at the schema level, the same way `taxes` doesn't enforce that dates don't
 * overlap (see below).
 *
 * `effective_to` is inclusive (the last date this version applies) and
 * nullable (an open-ended, currently-active version has none). There is
 * deliberately NO status column: DATABASE.md §3's lifecycle table has no row
 * for `taxes` at all, and the effective-date pair already fully answers "is
 * this version live" — a status column would be a second, divergent source
 * of truth for the same fact `effective_to` already carries. Resolving
 * "which tax version applied on date X" is a plain read (`effective_from <=
 * X AND (effective_to IS NULL OR effective_to >= X)`), implemented as a pure
 * function in the setup module's service layer rather than a database view,
 * so it is directly unit-testable against dates before, during, and after a
 * rate change — without needing Phase 2's `folio_line_items` to exist at all.
 *
 * `UNIQUE(property_id, tax_code, effective_from)` — not
 * `UNIQUE(property_id, tax_code)` — because effective-dating means multiple
 * rows legitimately share one `tax_code` over time; what must stay unique is
 * one code starting on any given date twice. This does NOT stop two
 * versions' date ranges from overlapping (e.g. a mistaken `effective_from`
 * earlier than an existing version's `effective_to`) — that is a business-
 * rule check the service layer makes before inserting, not a constraint the
 * database can express declaratively without a range-exclusion feature MySQL
 * doesn't have.
 *
 * `calculation_method` and `rounding_method` are both narrower here than
 * ARCHITECTURE.md §12.1's own prose ("percentage of base, flat amount,
 * tiered, etc." / "rounding_method — see below"): only `percentage` and
 * `flat_amount` are accepted for `calculation_method`, and only `half_up`
 * for `rounding_method` — the one rounding rule §12.1 states as fixed
 * ("always round half-up"). `tiered` calculation has no defined tiering
 * shape anywhere in the spec, so implementing it now would mean inventing a
 * business rule ahead of the module that should own it; the enum stays
 * narrow rather than accepting a value nothing can compute correctly.
 *
 * `applies_to` is a short free-text label (e.g. "room_charges"), not an enum
 * against a charge-type taxonomy — no such taxonomy exists yet (it arrives
 * with Phase 2's cashiering module), so constraining this column to a fixed
 * list now would be the same ahead-of-phase mistake `rbac.js` documents for
 * not seeding the literal SECURITY.md §5 permission catalogue early.
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
  await knex.schema.createTable('taxes', (table) => {
    table.comment(
      'One effective-dated version of a tax or levy a property charges. Scope: PROPERTY_SCOPED. A rate change is a new row, never an UPDATE to an existing rate (ARCHITECTURE.md section 12.1).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .string('tax_code', 30)
      .notNullable()
      .comment('Stable identifier referenced by charges, e.g. "VAT", "TOURISM_LEVY" — never the display name (ARCHITECTURE.md §12.1). Shared by every effective-dated version of this tax.');

    table.string('name', 150).notNullable();

    table
      .decimal('rate', 12, 4)
      .notNullable()
      .comment('A percentage (e.g. 7.5000 = 7.5%) or a flat amount in the property\'s base currency, per calculation_method.');

    table
      .string('applies_to', 50)
      .notNullable()
      .defaultTo('all')
      .comment('Free-text charge-type label, e.g. "room_charges" — no fixed taxonomy exists yet (Phase 2). See file header.');

    table
      .date('effective_from')
      .notNullable()
      .comment('First business_date this version applies to (inclusive).');
    table
      .date('effective_to')
      .nullable()
      .comment('Last business_date this version applies to (inclusive). NULL = currently open-ended. See file header for why there is no separate status column.');

    table
      .boolean('is_inclusive')
      .notNullable()
      .comment('True if the quoted/displayed price already contains this tax (ARCHITECTURE.md §12.1\'s inclusive/exclusive distinction). No default — a property must choose explicitly, the same reasoning properties.timezone has no default.');

    table
      .enu('calculation_method', ['percentage', 'flat_amount'])
      .notNullable()
      .comment('"tiered" is named in ARCHITECTURE.md §12.1\'s prose but has no defined tiering shape anywhere in the spec — not modelled until a real module needs it. See file header.');

    table
      .integer('priority')
      .unsigned()
      .notNullable()
      .defaultTo(0)
      .comment('Order of application when multiple taxes apply to one charge (ARCHITECTURE.md §12.1) — lower runs first.');

    table
      .boolean('is_compound')
      .notNullable()
      .defaultTo(false)
      .comment('True if this tax applies to (base + prior taxes) rather than the base amount alone (ARCHITECTURE.md §12.1).');

    table
      .enu('rounding_method', ['half_up'])
      .notNullable()
      .defaultTo('half_up')
      .comment('ARCHITECTURE.md §12.1: "always round half-up" — the one method the spec defines. The column exists (per DATABASE.md\'s own field list) so a future rounding rule is a new enum value, not a schema change.');

    table.string('jurisdiction', 100).nullable();

    timestamps(knex, table);

    // One (property, code, start-date) combination — see file header for why
    // this is not a plain UNIQUE(property_id, tax_code).
    table.unique(['property_id', 'tax_code', 'effective_from'], {
      indexName: 'taxes_property_id_tax_code_effective_from_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'taxes_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The resolution query's own index: "every version of this tax_code, in
    // date order" and "which version covers date X".
    table.index(
      ['tenant_id', 'property_id', 'tax_code', 'effective_from'],
      'taxes_tenant_id_property_id_tax_code_effective_from_index'
    );
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('taxes');
};
