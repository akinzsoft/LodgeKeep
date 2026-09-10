'use strict';

/**
 * Group Blocks permission keys — PLAN.md Phase 4. Following the exact
 * select-or-insert idempotent pattern `20260918098000_seed_ar_permissions.js`
 * established.
 *
 * `group_blocks.view` (front_desk, cashier, manager, admin, super_admin) —
 * see a block, its rooming list, and its pickup progress. Mirrors `ar.view`'s
 * exact role set: a front-desk agent needs to see which block a walk-in
 * guest belongs to without being able to renegotiate the block itself.
 * `group_blocks.manage` (manager, admin, super_admin only) — create/edit a
 * block, configure room allocations. Billing a rooming list to its sponsor
 * (`POST /group-blocks/:id/bill-to-sponsor`) is gated on the existing
 * `ar.manage` instead — see `src/modules/group-blocks/routes.js`'s own
 * header for why.
 *
 * SECURITY.md §5's matrix gains a Group Blocks column in this same pass; see
 * that file's own updated text for the written definition.
 */

exports.up = async function up(knex) {
  const keys = ['group_blocks.view', 'group_blocks.manage'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'group_blocks.view', name: 'View group blocks, rooming lists and pickup', domain: 'group_blocks' },
    { permission_key: 'group_blocks.manage', name: 'Manage group blocks and room allocations', domain: 'group_blocks' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['group_blocks.view', 'group_blocks.manage']).delete();
};
