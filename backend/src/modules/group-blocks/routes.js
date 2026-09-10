'use strict';

/**
 * Route wiring for Group Blocks — PLAN.md Phase 4. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()`, same as every other business module.
 *
 * SECURITY.md §5's Group Blocks column: `group_blocks.view` (front desk,
 * cashier, manager, admin, super_admin) — see a block, its rooming list,
 * and its pickup progress. `group_blocks.manage` (manager, admin,
 * super_admin only) — create/edit a block, configure room allocations.
 *
 * `bill-to-sponsor` is deliberately gated on `ar.manage`, NOT
 * `group_blocks.manage` — mirroring SECURITY.md's already-established
 * "company-profile writes follow ar.manage too, even though the table
 * lives outside the AR module, since its fields exist primarily to serve
 * AR credit decisions" reasoning, applied here to a bulk billing action
 * rather than a field. Currently inert (both keys share an identical role
 * set — manager/admin/super_admin) but a real, intentional dependency
 * worth knowing if the two domains' role sets are ever allowed to diverge.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function groupBlocksRouter() {
  const router = Router();

  router.get('/group-blocks', requirePermission('group_blocks.view'), controller.listGroupBlocks);
  router.post('/group-blocks', requirePermission('group_blocks.manage'), controller.createGroupBlock);
  router.get('/group-blocks/:id', requirePermission('group_blocks.view'), controller.getGroupBlock);
  router.patch('/group-blocks/:id', requirePermission('group_blocks.manage'), controller.updateGroupBlock);

  router.get('/group-blocks/:id/rooms', requirePermission('group_blocks.view'), controller.listGroupBlockRoomAllocations);
  router.post('/group-blocks/:id/rooms', requirePermission('group_blocks.manage'), controller.upsertGroupBlockRoomAllocation);

  router.get('/group-blocks/:id/pickup', requirePermission('group_blocks.view'), controller.getBlockPickupSummary);

  router.post('/group-blocks/:id/bill-to-sponsor', requirePermission('ar.manage'), controller.billToSponsor);

  return router;
}

module.exports = { groupBlocksRouter };
