/**
 * Stock items grouped by their stock category — shared by every Stock tab
 * that picks a stock item from a `<select>` (Goods received, Wastage,
 * Recipes), so a category a manager created under Stock items is visible
 * everywhere a stock item can be chosen, not only on the Stock items tab
 * (user-reported: categories and items should show consistently across the
 * whole Stock menu).
 *
 * Categories sort alphabetically with "Uncategorized" last; items inside
 * a category sort by name. Each option keeps the exact same label as
 * before ("Name (unit)"), so nothing that reads an option's text changes.
 */

export const UNCATEGORIZED_LABEL = 'Uncategorized';

/** `[{label, items}]` — alphabetical categories, then Uncategorized; items by name. Empty input gives `[]`. */
export function groupStockItemsByCategory(items) {
  const groups = new Map();
  for (const item of items ?? []) {
    const label = item.category?.trim() ? item.category : UNCATEGORIZED_LABEL;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === UNCATEGORIZED_LABEL) return 1;
      if (b === UNCATEGORIZED_LABEL) return -1;
      return a.localeCompare(b);
    })
    .map(([label, groupItems]) => ({ label, items: groupItems.slice().sort((x, y) => x.name.localeCompare(y.name)) }));
}

/** The same order as the groups above, flattened — for a table that shows a Category column instead of headings. */
export function sortStockItemsByCategory(items) {
  return groupStockItemsByCategory(items).flatMap((group) => group.items);
}

/** `<option>`s inside one `<optgroup>` per category. Render it inside a `<select>`, after any placeholder option. */
export function StockItemOptions({ items }) {
  return groupStockItemsByCategory(items).map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name} ({item.unit})
        </option>
      ))}
    </optgroup>
  ));
}
