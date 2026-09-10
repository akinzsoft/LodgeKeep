'use strict';

/**
 * `src/modules/ar`'s public surface — PLAN.md Phase 4 (Accounts
 * Receivable), PRODUCT_REQUIREMENTS.md §3.9. Other code imports from here
 * or from `./service`/`./ageing` directly (as `cashiering/service.js` and
 * `reservations/service.js` do — a plain function import, not a route),
 * never from `./controller`/`./routes` behind this file's own router.
 *
 * Scope: company invoicing, credit management (a per-account, per-property
 * credit limit with a configurable block/flag-only enforcement mode),
 * outstanding-balance tracking (the ageing report, TESTING.md AR-2), and
 * manual payment recording/application against invoices (TESTING.md AR-1) —
 * no payment-gateway integration (this session's confirmed decision:
 * real-world B2B collections are wire/cheque, recorded after the fact, not
 * captured through Paystack). `company_profiles` itself lives in
 * `src/modules/profiles` (DATABASE.md's own filing under Guests & CRM) —
 * this module reads it by id, the same cross-module service-call shape
 * `cashiering/service.js` already uses to reach `reservations/service.js`.
 */

const { arRouter } = require('./routes');

module.exports = { arRouter };
