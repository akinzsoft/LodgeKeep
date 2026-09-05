'use strict';

/**
 * Cashiering (PLAN.md Phase 2.5, PRODUCT_REQUIREMENTS.md §3.5) needs two
 * things the Phase 2 `folios` stub does not have:
 *
 * 1. **A 3-column composite parent key.** `folio_line_items` and `payments`
 *    (this pass's own new tables) are PROPERTY_SCOPED tables referencing
 *    ANOTHER PROPERTY_SCOPED table (`folios`) — DATABASE.md §2's own rule:
 *    "the first time one PROPERTY_SCOPED table references another
 *    PROPERTY_SCOPED table ... the referencing FK must be the full 3-column
 *    composite ... and the referenced table needs that composite declared
 *    as its own unique constraint." `room_types`/`rate_codes` already added
 *    this in Phase 1 for the identical reason; `folios` never needed it
 *    until now because nothing referenced it back in Phase 2.
 * 2. **`billed_to`** — DATABASE.md §1's own folios row names it
 *    ("reservation_id, folio_number, billed_to, company_profile_id,
 *    currency, status"), deliberately left out of the Phase 2 stub's
 *    migration (see that file's own header) because nothing needed split
 *    billing yet. Cashiering's "split billing across guests/accounts"
 *    (PRODUCT_REQUIREMENTS.md §3.5) is real scope now — `billed_to` is a
 *    free-text label ('Guest', 'Company ABC', ...), NOT a
 *    `company_profile_id` FK: no company-profile concept exists anywhere in
 *    this schema (Accounts Receivable, §3.9, is Phase 4), so a real FK here
 *    would be building ahead of a module that doesn't exist. A reservation
 *    can now have MORE than one folio (a second folio opened explicitly for
 *    a split), each with its own `billed_to` label and its own
 *    `folio_number` — `UNIQUE(reservation_id, folio_number)` (already in
 *    place since Phase 2) is exactly what makes multiple folios per
 *    reservation safe.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('folios', (table) => {
    table
      .string('billed_to', 150)
      .notNullable()
      .defaultTo('Guest')
      .comment('Free-text split-billing label (e.g. "Guest", "Company ABC") — no company_profile_id FK exists yet (Phase 4, Accounts Receivable). See migration header.');

    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'folios_tenant_id_property_id_id_unique' });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('folios', (table) => {
    table.dropUnique(['tenant_id', 'property_id', 'id'], 'folios_tenant_id_property_id_id_unique');
    table.dropColumn('billed_to');
  });
};
