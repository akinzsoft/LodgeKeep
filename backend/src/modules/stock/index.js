'use strict';

/**
 * Stock module — PLAN.md Phase 6's "POS inventory & stock control"
 * (PRODUCT_REQUIREMENTS.md §3.4), the last of the six Phase 6 candidate
 * items PLAN.md itself names, and the one this pass finally builds.
 *
 * Built this pass: stock items (raw ingredients/consumables), a per-menu-
 * item recipe/BOM, real deduction on settlement (hooked into BOTH real
 * settlement writers this codebase has — `pos/service.js`'s `settleOrder`
 * and `cashiering/service.js`'s `finalizePosOrderCardCapture`), the
 * matching reversal on a post-settlement void, goods-received (last-cost
 * only), wastage (mandatory reason), the proactive stock-out guard
 * (`applyStockAvailabilityEffects` — a component hitting ≤ 0 auto-flips
 * its dependent menu item unavailable, reversibly, never fighting a human's
 * own manual toggle), a full blind stock-take lifecycle (open → count →
 * complete, revealing variance only at completion, exactly like
 * `pos_shifts`' own cash-up), and cost-of-sales/variance reporting.
 *
 * ── FIVE CONFIRMED, DELIBERATE SCOPE REDUCTIONS ──────────────────────────
 *
 * 1. **Negative stock is allowed, never blocked.** Settlement/deduction
 *    always completes, even past zero — the guard is proactive only
 *    (prevents NEW orders once a component hits ≤ 0), never a hard stop
 *    on a sale already in flight.
 * 2. **Modifiers do not affect recipe quantity.** A recipe deducts the
 *    same fixed quantity regardless of which JSON `modifiers` option an
 *    order line chose — a real, named gap, not an oversight (see
 *    `pos_menu_item_components`' own migration header).
 * 3. **Costing is last-cost only, never weighted-average.** Goods-received
 *    wholesale-replaces `stock_items.purchase_cost` with the new
 *    delivery's own unit cost.
 * 4. **Unit tracking is same-unit-only.** `stock_items.unit` is a free
 *    string with NO conversion table — a recipe's quantity and a
 *    delivery's quantity must already share that item's own unit. Real
 *    cross-unit conversion (e.g. bottles ↔ millilitres) is out of scope,
 *    flagged rather than half-built.
 * 5. **RBAC is two keys, no view/manage split finer than that.**
 *    `pos.stock_view` (pos_operator/manager/admin/super_admin — read
 *    levels/alerts, record wastage with a mandatory reason) and
 *    `pos.stock_manage` (manager/admin/super_admin only — everything
 *    else: item CRUD, recipe/BOM, goods-received, the stock-take
 *    lifecycle, cost/variance reporting).
 *
 * ── ONE-WAY DEPENDENCY, LIKE EVERY OTHER MODULE PAIR IN THIS CODEBASE ────
 *
 * `pos/service.js` and `cashiering/service.js` each require this module
 * (for the settlement-side deduction/reversal hooks); this module never
 * requires either of them back, nor `qr-ordering/service.js` — see
 * `service.js`'s own header for the full reasoning.
 */

const { stockRouter } = require('./routes');

module.exports = { stockRouter };
