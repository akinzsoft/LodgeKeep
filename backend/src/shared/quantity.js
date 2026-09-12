'use strict';

/**
 * Exact decimal QUANTITY arithmetic — PLAN.md Phase 6's POS inventory &
 * stock control, mirroring `src/shared/money.js`'s own BigInt-scaled
 * technique exactly (ARCHITECTURE.md §1: "Never float, anywhere"), just at
 * a different fixed precision: every quantity column this pass introduces
 * (`stock_items.current_quantity`/`reorder_level`,
 * `pos_menu_item_components.quantity`, `stock_movements.quantity`,
 * `stock_take_lines.counted_quantity`/`theoretical_quantity`/`variance`)
 * is DECIMAL(14,3) — three decimal places, not money's two — since a
 * recipe or a delivery is routinely fractional at finer-than-cent
 * granularity (0.125 litres of a spirit per cocktail, 0.5kg of a
 * garnish). Converting to integer "quantity units" (×1000) via BigInt and
 * back is exact, the identical reasoning `money.js`'s own header gives for
 * cents.
 *
 * `extendedCost` is the one function that crosses precisions on purpose:
 * `unit_cost` is money (2dp, cents), `quantity` is a quantity (3dp, qty
 * units) — their product needs rounding back down to a 2dp money value,
 * half-up to the nearest cent, the exact same rounding idiom
 * `percentOfMoney`/`inclusiveTaxPortion` already use in `money.js` (an
 * integer numerator/denominator ratio rounded via
 * `(abs*2+denominator)/(2*denominator)`), reused here rather than
 * reinvented.
 */

const { toCents, fromCents } = require('./money');

const QTY_SCALE = 1000n;

function toQtyUnits(decimalString) {
  const [whole, fraction = ''] = String(decimalString).split('.');
  const paddedFraction = `${fraction}000`.slice(0, 3);
  const negative = whole.startsWith('-');
  const wholeAbs = negative ? whole.slice(1) : whole;
  const units = BigInt(wholeAbs || '0') * QTY_SCALE + BigInt(paddedFraction || '0');
  return negative ? -units : units;
}

function fromQtyUnits(units) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const wholePart = abs / QTY_SCALE;
  const fractionPart = abs % QTY_SCALE;
  return `${negative ? '-' : ''}${wholePart}.${fractionPart.toString().padStart(3, '0')}`;
}

/** Sums an array of DECIMAL(14,3)-as-string quantity values exactly, returning a 3-decimal string. `[]` sums to '0.000'. */
function sumQuantity(values) {
  const totalUnits = values.reduce((total, value) => total + toQtyUnits(value), 0n);
  return fromQtyUnits(totalUnits);
}

/** The additive inverse of a quantity value — `'2.500' -> '-2.500'`, `'-1.000' -> '1.000'`. */
function negateQuantity(value) {
  return fromQtyUnits(-toQtyUnits(value));
}

/** A recipe component's per-unit quantity × how many units of the menu item were sold — the whole-order deduction for one component. `count` is a plain (non-fractional) integer, e.g. `pos_order_items.quantity`. */
function multiplyQuantityByInteger(quantityStr, count) {
  return fromQtyUnits(toQtyUnits(quantityStr) * BigInt(count));
}

/** Exact comparison — never a float `<`/`>` (ARCHITECTURE.md §1). */
function compareQuantity(a, b) {
  const diff = toQtyUnits(a) - toQtyUnits(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

/**
 * `unitCostStr` (money, 2dp) × `quantityStr` (quantity, 3dp), rounded
 * half-up to the nearest cent — the total cost of a `stock_movements` row.
 * Crosses precisions deliberately: the product of a 2dp and a 3dp value is
 * naturally 5dp, and this pass's own confirmed scope (last-cost, never
 * weighted-average) has no use for finer-than-cent cost tracking.
 */
function extendedCost(unitCostStr, quantityStr) {
  const costCents = toCents(unitCostStr);
  const qtyUnits = toQtyUnits(quantityStr);
  const numerator = costCents * qtyUnits;
  const denominator = QTY_SCALE;
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const roundedAbs = (absNumerator * 2n + denominator) / (2n * denominator);
  return fromCents(negative ? -roundedAbs : roundedAbs);
}

module.exports = {
  sumQuantity,
  negateQuantity,
  multiplyQuantityByInteger,
  compareQuantity,
  extendedCost,
  toQtyUnits,
  fromQtyUnits,
};
