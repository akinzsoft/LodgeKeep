'use strict';

/**
 * `src/auth`'s public surface — ARCHITECTURE.md §2 lists this alongside
 * `/audit` and `/jobs` as top-level, not under `/modules`, since it is
 * cross-cutting infrastructure every module's routes sit behind rather than a
 * single business domain.
 *
 * Other code imports from here, never from the files behind it (CLAUDE.md's
 * module-boundary rule) — `authenticate` is what a future module's protected
 * routes are built with; the route factories are what `src/app.js` mounts.
 */

const { staffAuthRouter, portalAuthRouter, platformAuthRouter } = require('./routes');
const { authenticate } = require('./middleware');
const { requirePermission } = require('./rbac');

module.exports = {
  staffAuthRouter,
  portalAuthRouter,
  platformAuthRouter,
  authenticate,
  requirePermission,
};
