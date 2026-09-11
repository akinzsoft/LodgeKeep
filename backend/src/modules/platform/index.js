'use strict';

/**
 * `src/modules/platform`'s public surface — PLAN.md Phase 5 (Platform
 * Foundation). Scope: the platform console's read-only tenant roster and
 * the impersonation grant lifecycle. Reaching a tenant's actual operational
 * data is explicitly NOT this module — see `service.js`'s own header.
 */

const { platformConsoleRouter, staffImpersonationRouter } = require('./routes');

module.exports = { platformConsoleRouter, staffImpersonationRouter };
