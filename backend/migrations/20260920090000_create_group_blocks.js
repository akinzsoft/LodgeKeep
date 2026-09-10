'use strict';

/**
 * `group_blocks` — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.8 ("Group
 * room blocks and rooming lists," "Group billing," "Meeting/event
 * integration") — correcting a repo-wide "§3.7" typo the two forward
 * reference migrations below carried (§3.7 is Rooms Management; the same
 * class of off-by-one the AR pass already fixed for its own §3.8→§3.9
 * citation). Closes `reservations.group_block_id`'s forward reference,
 * FK-less since that column's own migration (20260906093000).
 *
 * Scope: PROPERTY_SCOPED, following `room_types`/`ar_accounts` — a group
 * block is negotiated against one property's own inventory, not shared
 * across a tenant's properties.
 *
 * ── TRACKING-ONLY, NOT A HOLD (this session's confirmed decision) ───────
 *
 * A block records a negotiated target for reporting only. It never
 * withdraws inventory from `room_type_inventory` — a reservation tagged
 * with `group_block_id` books through the exact same last-room-race
 * mechanism (`reserveInventoryForDates`) any other reservation does, with
 * zero special-casing. "Pickup" (rooms actually booked vs. `rooms_blocked`,
 * see `group_block_rooms` below) is always computed live from real
 * reservations — never a stored counter — the same "one source of truth,
 * always re-derived" discipline `ar_accounts.current_balance`/
 * `folios.balance` already established. `cutoff_date` is informational
 * only: nothing here automatically releases an unpicked-up allocation back
 * to general sale, since there is no hold to release in the first place.
 *
 * `company_profile_id` is nullable (this session's confirmed decision:
 * optional AR sponsorship) — a block sponsored by a real company/travel
 * agent can have its rooming list billed to that company's existing
 * `ar_accounts` row (`src/modules/group-blocks/service.js`'s
 * `billBlockReservationsToSponsor`, reusing `cashiering.billFolioToCompany`
 * verbatim); an unsponsored block (a family reunion, a one-off group with
 * no commercial entity) has no consolidated master bill at all — every
 * reservation in it settles its own folio individually, unchanged.
 *
 * `status`: a plain `active`/`cancelled` enum, not a three-value
 * tentative/definite/cancelled vocabulary — nothing in this design
 * behaviourally distinguishes "tentative" from "active" (no inventory
 * hold either way), so a third state would sit unused. `cancelled` is the
 * one enforcement point: `createReservation` refuses to tag a new
 * reservation to a cancelled block (a stale-client mistake, not a
 * legitimate exception), while nothing constrains a reservation's own
 * stay dates against the block's `start_date`/`end_date` — see that
 * function's own comment for why (the same "a request, never a lock"
 * reasoning `preferred_room_id` already established).
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
  await knex.schema.createTable('group_blocks', (table) => {
    table.comment(
      'A negotiated room block for a group/event - tracking and reporting only, never an inventory hold. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('company_profile_id').unsigned().nullable().comment('Optional AR sponsor - see migration header.');

    table.string('block_name', 200).notNullable();
    table.date('start_date').notNullable();
    table.date('end_date').notNullable();
    table.date('cutoff_date').nullable().comment('Informational only - nothing automated reads this. See migration header.');
    table.enu('status', ['active', 'cancelled']).notNullable().defaultTo('active');
    table.text('notes').nullable();

    timestamps(knex, table);

    // Parent key for group_block_rooms and for closing reservations.group_block_id's FK.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'group_blocks_tenant_property_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'group_blocks_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 2-column: company_profiles is TENANT_SCOPED, the same shape
    // ar_accounts_tenant_company_foreign already uses.
    table
      .foreign(['tenant_id', 'company_profile_id'], 'group_blocks_tenant_company_foreign')
      .references(['tenant_id', 'id'])
      .inTable('company_profiles')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'group_blocks_tenant_property_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('group_blocks');
};
