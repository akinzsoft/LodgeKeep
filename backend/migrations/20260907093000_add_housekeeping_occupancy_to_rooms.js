'use strict';

/**
 * Adds the housekeeper's physically-observed OCCUPANCY to `rooms` — PLAN.md
 * Phase 3, PRODUCT_REQUIREMENTS.md §3.6's discrepancy requirement: "front
 * desk's system status for a room (e.g. vacant/dirty from checkout) and the
 * housekeeper's physically-observed status (e.g. still occupied, or occupied
 * but not checked in) can disagree."
 *
 * `rooms.front_desk_status` (vacant/occupied) and `rooms.housekeeping_
 * reported_status` (clean/dirty) already exist (Phase 1's rooms migration),
 * but they answer two DIFFERENT questions — occupancy vs cleanliness — and
 * are not directly comparable. The actual discrepancy PRODUCT_REQUIREMENTS.md
 * describes ("still occupied", "occupied but not checked in") is specifically
 * an OCCUPANCY disagreement: front desk believes a room is vacant (the guest
 * checked out) but the housekeeper, physically inspecting it, still finds it
 * occupied. `housekeeping_occupancy_observed` is that missing second opinion
 * on the SAME axis as `front_desk_status`, submitted whenever housekeeping
 * reports a room's status (`src/modules/housekeeping/service.js`, this pass).
 *
 * Nullable: a room housekeeping has never inspected has no observation yet,
 * which is a different (and unremarkable) state from an active disagreement.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('rooms', (table) => {
    table
      .enu('housekeeping_occupancy_observed', ['vacant', 'occupied'])
      .nullable()
      .comment(
        'The housekeeper\'s own physical occupancy observation, compared against front_desk_status to detect a discrepancy (PRODUCT_REQUIREMENTS.md section 3.6). Null until housekeeping has ever reported a status for this room.'
      );
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('rooms', (table) => {
    table.dropColumn('housekeeping_occupancy_observed');
  });
};
