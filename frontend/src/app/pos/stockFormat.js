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

/**
 * A purely visual threshold for an "On hand" column's pill — never written
 * back anywhere, so a plain `Number()` comparison is fine here even though
 * this codebase's own "quantity is exact, always" rule (mirroring
 * ARCHITECTURE.md §1/§12 for money) governs every real WRITE to a quantity
 * value. Matches the "Low stock only" filter's own definition
 * (`current_quantity <= reorder_level`) exactly for the warning tier, and
 * adds a distinct, more urgent tier once it's actually at or below zero.
 *
 * Shared by `StockItemsTab.jsx` and `MenuItemsTab.jsx` — the latter shows
 * this for a menu item's own linked stock item, the identical signal.
 */
export function stockLevelTone(currentQuantity, reorderLevel) {
  const quantity = Number(currentQuantity);
  if (quantity <= 0) return { tone: 'danger', label: 'Out of stock' };
  if (quantity <= Number(reorderLevel)) return { tone: 'warning', label: 'Low stock' };
  return null;
}
