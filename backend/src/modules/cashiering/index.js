'use strict';

/**
 * Cashiering module — PLAN.md Phase 2.5 step 1 ("the real folio ledger")
 * and step 2 ("Payment integration"), PRODUCT_REQUIREMENTS.md §3.5.
 *
 * Built this pass: `folio_line_items` (the real ledger the Phase 2 `folios`
 * stub was always missing — see that migration's own header), a real tax
 * engine (`tax-engine.js`, ARCHITECTURE.md §12.1 — multi-tax, compound,
 * inclusive/exclusive, effective-dated), split billing (multiple folios per
 * reservation, moving a line item between them), void-with-reason
 * (ARCHITECTURE.md §8), corrections/adjustments, and payment capture for
 * TWO real providers: `cash` (synchronous, no external system) and
 * `paystack` (a genuine sandbox integration — initialize, verify, webhook
 * with signature verification, and refunds — `paystack-adapter.js`, using
 * this session's own supplied test credentials).
 *
 * Deliberately NOT built this pass: Flutterwave (PRODUCT_REQUIREMENTS.md
 * §3.5 names it; no sandbox credentials exist in this environment — the
 * `payments.provider` column is a free string specifically so adding it
 * later needs no schema change), per-guest/company tax exemptions and
 * discount-affects-taxable-base interactions (ARCHITECTURE.md §12.1 names
 * both; no company-profile concept exists anywhere in this codebase yet —
 * §3.9 Accounts Receivable is Phase 4), and multi-currency/FX conversion
 * (ARCHITECTURE.md §12.2 — every property/reservation/folio in this
 * codebase is still single-currency; a real FX-locking mechanism is a
 * distinct, substantial piece of scope this pass does not claim). Each is a
 * flagged, deliberate reduction, not an oversight — the same "flagged stub,
 * not invented behaviour" discipline every earlier phase in this codebase
 * has followed.
 */

const { cashieringRouter, paystackWebhookRouter } = require('./routes');

module.exports = { cashieringRouter, paystackWebhookRouter };
