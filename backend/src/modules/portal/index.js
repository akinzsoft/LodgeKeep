'use strict';

/**
 * `src/modules/portal`'s public surface — PLAN.md Phase 4. Other code
 * imports from here, never from the files behind it.
 */

const { portalPublicRouter, portalAccountRouter } = require('./routes');

module.exports = { portalPublicRouter, portalAccountRouter };
