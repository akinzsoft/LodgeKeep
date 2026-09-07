'use strict';

/**
 * POS module — PLAN.md Phase 4's POS core, PRODUCT_REQUIREMENTS.md §3.4.
 *
 * Built this pass: outlets, terminals, menu management (including the
 * stock-out toggle), order flow (multiple simultaneous tabs, item add/
 * void-before-settlement, item-group split billing), settlement (cash/card
 * direct, and charge-to-room posting a real `pos_charge` folio line through
 * the existing Cashiering module), and blind cash-up shifts.
 *
 * **Modifiers are schema/service-layer only, not UI-reachable** —
 * `pos_menu_items.modifiers` (the available groups/price deltas) and
 * `computeItemLineTotal`'s pricing of a chosen modifier both exist and are
 * correct, but neither `SetupTab` (defining a menu item) nor `RegisterTab`
 * (ringing one up) has a control to define or select one. Reachable only
 * by calling the API directly — a real, flagged gap, not a silently
 * hidden feature; the natural next increment once this module gets a
 * follow-up pass, not claimed as "built" here.
 *
 * Deliberately NOT built this pass, per PLAN.md's own Phase 4 scoping and
 * this session's confirmed decisions:
 * - **QR self-ordering** (signed table/room tokens, guest-facing ordering
 *   pages, live order status) — Phase 6, per PLAN.md.
 * - **Inventory & stock control** (stock items, recipes/BOM, goods
 *   received, stock takes, wastage, low-stock alerts) — Phase 6, per
 *   PLAN.md. `pos_menu_items` has no `cost_price`/component columns as a
 *   result — see that migration's own header.
 * - **Happy-hour/time-based menu pricing** — real §3.4 scope, but not in
 *   DATABASE.md's original schema draft at all; flagged as a new gap
 *   alongside inventory rather than silently built or silently dropped.
 * - **Night Audit step 7** (reconciling POS outlet totals into
 *   `daily_reports`/folios) — already flagged skipped since Phase 2.5
 *   (no POS module existed to reconcile); now a real, newly-closeable
 *   follow-on, not closed in this pass.
 * - **POS reporting** (itemised sales by outlet/item/staff/hour, top/slow
 *   sellers) — PLAN.md's own Phase 4 bullet names "outlets, terminals,
 *   menu, order flow, cash-up, charge-to-room" as core; reporting is a
 *   separate, deferred follow-on.
 * - **Real offline order queueing** — PRODUCT_REQUIREMENTS.md §3.4 asks
 *   for local queueing while the app is offline, syncing on reconnect.
 *   This pass reuses the same disable-actions-and-banner pattern every
 *   other screen in this app already uses, a real, named scope reduction
 *   (flagged in CLAUDE.md), not the full originally-specified capability.
 * - **Real hardware integration** — signature capture, key-card readers,
 *   NFC/contactless terminal APIs, kitchen ticket printers. Room-charge
 *   authorization is a property-configured method plus a short operator
 *   attestation field, the same "confirm the decision, no hardware"
 *   pattern already used for the door-lock adapter picker. The kitchen/bar
 *   "ticket" is a live on-screen queue, not a physical print.
 */

const { posRouter } = require('./routes');

module.exports = { posRouter };
