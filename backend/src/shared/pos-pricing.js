'use strict';

/**
 * The POS per-item price/modifier arithmetic — promoted out of
 * `src/modules/pos/service.js` (PLAN.md Phase 4) once PLAN.md Phase 6's QR
 * self-ordering module needed the identical computation to price a guest's
 * cart before an order even exists (`qr-ordering/service.js`'s own
 * `sumOpenUnpaidValueForToken`/`createGuestOrder`), the same "promote a
 * one-off once a second caller needs it" pattern this codebase already
 * uses (`src/shared/money.js`, `runIdempotentMutation`,
 * `resolvePropertyBySlug`). `pos/service.js` re-exports this unchanged so
 * no existing import breaks.
 */

const { toCents, fromCents } = require('./money');

/** Every menu-item price/modifier lookup and item-add goes through this exact cents math — no floats, ever (ARCHITECTURE.md §1). */
function computeItemLineTotal({ unit_price: unitPrice, quantity, modifiers }) {
  const modifierDeltaCents = (modifiers ?? []).reduce((sum, m) => sum + toCents(m.priceDelta ?? '0.00'), 0n);
  const perUnitCents = toCents(unitPrice) + modifierDeltaCents;
  return fromCents(perUnitCents * BigInt(quantity));
}

/**
 * The Register's fixed service charge, as a percentage of a check's net
 * subtotal. The Register screen shows and sends this amount; the server
 * needs the same figure to price a card/NQR Paystack checkout itself
 * rather than trusting an amount from the request body.
 */
const POS_SERVICE_CHARGE_PERCENT = '7.5';

module.exports = { computeItemLineTotal, POS_SERVICE_CHARGE_PERCENT };
