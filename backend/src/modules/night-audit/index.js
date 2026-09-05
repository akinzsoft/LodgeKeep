'use strict';

/**
 * Night Audit module — PLAN.md Phase 2.5 step 3, PRODUCT_REQUIREMENTS.md
 * §3.10, ARCHITECTURE.md §6 (the full run sequence and recovery model).
 *
 * Built this pass: the exact 13-step sequence (§6.2) — steps 5 and 7
 * (package charges, POS reconciliation) are skipped outright since no
 * packages or POS module exists anywhere in this codebase (Phase 4/6),
 * flagged rather than silently glossed over; every other step is real,
 * including a genuine `daily_reports` snapshot computed from the REAL
 * `folio_line_items` ledger Cashiering just built (not a
 * `reservation_daily_rates` guess) — closing PLAN.md Phase 3's own named
 * gap ("Report figures reconcile against the underlying folio data").
 * The run-state machine (§6.1) and its unique-row-per-date claim
 * mechanism, and §6.3's crash-recovery reality check, are both real and
 * directly tested against genuinely concurrent/committed rows, the same
 * discipline `tests/reservations/concurrency.test.js` established for the
 * last-room race.
 *
 * Deliberately NOT built this pass: a continuously-running monitor process
 * sweeping `heartbeat_at` for stale runs (recovery is evaluated lazily, on
 * the next run attempt — see `service.js`'s own header), and
 * `report_schedules`/scheduled report delivery (needs a notification-
 * settings screen that does not exist — still Phase 3's own flagged gap).
 */

const { nightAuditRouter } = require('./routes');

module.exports = { nightAuditRouter };
