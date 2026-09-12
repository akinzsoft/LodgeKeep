/**
 * A stock quantity is NOT money (`backend/src/shared/quantity.js`'s own
 * exact-DECIMAL-string arithmetic, distinct from `shared/money.js`) — it
 * must never be run through `formatMoney`/`<Money>`, which assumes a
 * currency. This is the plain-number-plus-unit equivalent for a quantity
 * column: the backend already returns a fixed-precision DECIMAL string
 * (e.g. "12.500"), so no numeric formatting is needed here, only pairing it
 * with the item's own `unit` string (e.g. "12.500 ml", "3 each").
 */
export function formatQuantity(quantity, unit) {
  if (quantity == null) return '—';
  return unit ? `${quantity} ${unit}` : String(quantity);
}
