'use strict';

/**
 * `src/modules/users`' public surface — PLAN.md Phase 1 gap closure. Other
 * code imports from here, never from the files behind it.
 */

const { usersRouter } = require('./routes');

module.exports = { usersRouter };
