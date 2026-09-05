'use strict';

/**
 * Reporting module — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.11.
 *
 * PLAN.md Phase 2.5 closed the gap this header used to flag: occupancy and
 * revenue now read the real `daily_reports` snapshot
 * (`src/modules/night-audit/service.js`) for any business_date Night Audit
 * has already closed — audited, historically reproducible figures,
 * reconciled against the real `folio_line_items` ledger Cashiering built
 * in the same pass — falling back to the original LIVE computation
 * (`room_type_inventory`/`reservation_daily_rates`) only for a date with
 * no snapshot yet, almost always the property's own current, still-open
 * business date. Each returned day carries `audited: true/false` so a
 * caller (and the UI) can tell which figure it is looking at. Housekeeping
 * summary and tonight's oversold room types stay live-computed — neither
 * has a Night Audit snapshot equivalent. CSV export only (`?format=csv`);
 * no PDF/Excel — no such library exists in this codebase and adding one
 * for a single report screen would be new, unrelated infra.
 *
 * Deliberately NOT built this pass: a report catalogue/dashboard-builder
 * screen, custom per-role dashboards, and scheduled report delivery
 * (PRODUCT_REQUIREMENTS.md §3.11 names these; scheduled delivery in
 * particular needs the Notifications module's outbox AND a settings UI
 * neither of which extends that far yet).
 */

const { reportingRouter } = require('./routes');

module.exports = { reportingRouter };
