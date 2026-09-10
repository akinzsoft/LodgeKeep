'use strict';

/**
 * `src/modules/group-blocks`'s public surface — PLAN.md Phase 4,
 * PRODUCT_REQUIREMENTS.md §3.8 (room blocks, rooming lists, pickup
 * tracking, group billing). Other code should `require('../group-blocks/service')`
 * directly for cross-module calls, the same convention `ar/index.js`
 * documents — nothing needs to call INTO this module in this pass (AR and
 * Cashiering don't reach back into it), only out of it.
 *
 * Scope: block CRUD, per (room type, night) room-allocation targets, a
 * derived pickup report (never a stored counter — see `service.js`'s
 * header), and bulk group billing that reuses AR's existing account/
 * credit-limit/invoicing machinery verbatim when a block has a sponsoring
 * company profile. No rooming-list roster table — a rooming-list entry is
 * simply a reservation tagged with `group_block_id`
 * (`reservations/service.js`).
 */

const { groupBlocksRouter } = require('./routes');

module.exports = { groupBlocksRouter };
