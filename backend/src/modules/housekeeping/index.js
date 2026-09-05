'use strict';

/**
 * Housekeeping module — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.6.
 *
 * Built this pass: attendant assignments, the mobile status board, the
 * front-desk-vs-housekeeping occupancy discrepancy detection and its
 * dedicated report/resolve flow, and date-ranged out-of-order/out-of-service
 * periods (the mechanism PLAN.md Phase 3's own test gate — "out-of-order
 * room is excluded from sellable inventory" — is written against).
 *
 * Deliberately NOT built this pass, per CLAUDE.md's own warning against
 * building ahead of PLAN.md's current phase: room inspections, maintenance
 * requests, lost & found, and linen/minibar management. Each is real
 * PRODUCT_REQUIREMENTS.md §3.6 scope, but none is named in PLAN.md Phase 3's
 * own bullet list ("attendant assignments, mobile status board, discrepancy
 * detection and report") or its test-gate list — building them now would be
 * exactly the "PRODUCT_REQUIREMENTS.md is the full eventual scope, not a
 * build list" trap CLAUDE.md names explicitly.
 */

const { housekeepingRouter } = require('./routes');

module.exports = { housekeepingRouter };
