/**
 * Groups a flat `items` list (each carrying a plain `category` name string
 * — `pos_menu_items.category`/`stock_items.category`, never a live FK)
 * under each of `categories`' own real rows (in display order), so every
 * registered category shows as its own section — including one with zero
 * items, so "create an item directly inside a category" has somewhere to
 * click even before any item exists there yet.
 *
 * Shared by `StockItemsTab.jsx` and `MenuItemsTab.jsx` — the two real
 * callers of this exact grouping shape, extracted once the second needed
 * it rather than duplicated a second time.
 *
 * An item pointing at a category that has SINCE been archived (a
 * defensive case, not normally reachable through the UI — both category
 * types refuse an archive while any item still uses them — but flagged
 * and handled the same "never silently hide real data" way this
 * codebase's own conventions already establish elsewhere) gets its own
 * clearly-labelled section too, rather than silently vanishing from the
 * screen — it just can't accept new items, since an archived category can
 * no longer be chosen for one.
 *
 * `includeUncategorized` (default `true`) appends a final "Uncategorized"
 * section, always present, covering items with no category at all — real
 * for stock items (whose category is optional) but never reachable for
 * menu items (whose category is a required field), so `MenuItemsTab`
 * passes `false` and never renders a section that could never hold
 * anything.
 *
 * Every section also carries a `selectId` — a real category's own numeric
 * `id` for a real category section, or the section's own string `key` for
 * the two kinds of section that aren't a real, manageable category row
 * (archived-but-referenced, Uncategorized). This is the one value a
 * single-category selector and the categories card's own row keys
 * (`row.id ?? row.key`) both agree on, so "which section is selected" and
 * "which category row is highlighted" can never drift apart.
 */
export function computeCategorySections(categories, items, { includeUncategorized = true, noun = 'category' } = {}) {
  const sortedCategories = (categories ?? [])
    .slice()
    .sort((a, b) => (a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.name.localeCompare(b.name)));
  const activeNames = new Set(sortedCategories.map((category) => category.name));

  const itemsByCategoryName = new Map();
  const uncategorizedItems = [];
  for (const item of items ?? []) {
    if (!item.category) {
      uncategorizedItems.push(item);
      continue;
    }
    if (!itemsByCategoryName.has(item.category)) itemsByCategoryName.set(item.category, []);
    itemsByCategoryName.get(item.category).push(item);
  }

  const sections = sortedCategories.map((category) => ({
    key: `category-${category.id}`,
    selectId: category.id,
    title: category.name,
    categoryName: category.name,
    canAddItem: true,
    items: itemsByCategoryName.get(category.name) ?? [],
  }));

  for (const [name, categoryItems] of itemsByCategoryName) {
    if (!activeNames.has(name)) {
      const key = `archived-category-${name}`;
      sections.push({ key, selectId: key, title: `${name} (archived ${noun})`, categoryName: name, canAddItem: false, items: categoryItems });
    }
  }

  if (includeUncategorized) {
    sections.push({ key: 'uncategorized', selectId: 'uncategorized', title: 'Uncategorized', categoryName: null, canAddItem: true, items: uncategorizedItems });
  }

  return sections;
}
