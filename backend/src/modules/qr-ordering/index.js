'use strict';

/**
 * `src/modules/qr-ordering`'s public surface — PLAN.md Phase 6
 * (PRODUCT_REQUIREMENTS.md §3.4's QR-ordering section, deferred from the
 * already-shipped POS core pass). Other code imports from here, never
 * from the files behind it.
 */

const { qrOrderPublicRouter, qrOrderStaffRouter } = require('./routes');

module.exports = { qrOrderPublicRouter, qrOrderStaffRouter };
