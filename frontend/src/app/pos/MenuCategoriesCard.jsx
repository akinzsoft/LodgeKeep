import { CategoryCatalogueCard } from '../../shared/components/index.js';
import { posApi } from '../../shared/api/index.js';

/**
 * MenuCategoriesCard — the property's registered menu categories (Starters,
 * Mains, Drinks…), shared by every outlet. Menu items pick a category from a
 * dropdown fed by this list, so names stay consistent on the Register rail
 * and the guest QR menu. Register, rename (applied to every item using the
 * category), reorder, and archive (refused while items still use it).
 * Changes are `pos.manage`; a lower-tier account sees the real 403.
 *
 * A thin wrapper around the shared `CategoryCatalogueCard` — see that
 * component's own header for why (this was one of three near-identical,
 * independently hand-built cards before this refactor).
 *
 * `extraRows`/`selectedRowKey`/`onSelectRow` thread straight through to
 * `CategoryCatalogueCard`'s own opt-in row-selection mode — `MenuItemsTab`
 * is this card's one caller that uses it, for its own single-selected-
 * category items view (mirroring `StockCategoriesCard`'s identical role).
 */
export function MenuCategoriesCard({ categories, onChanged, extraRows, selectedRowKey, onSelectRow }) {
  return (
    <CategoryCatalogueCard
      title="Menu categories"
      hint="Categories are shared by every outlet. Menu items choose one of these, so the Register and guest menu show consistent names. Click a category to see its items below."
      namePlaceholder="e.g. Starters"
      countColumnLabel="Menu items"
      renameHint="Renaming updates every menu item in this category."
      archiveConsequence="will no longer be offered for menu items. A category still used by menu items cannot be archived — move those items first."
      categories={categories}
      onChanged={onChanged}
      api={{ create: posApi.createMenuCategory, update: posApi.updateMenuCategory, archive: posApi.archiveMenuCategory }}
      extraRows={extraRows}
      selectedRowKey={selectedRowKey}
      onSelectRow={onSelectRow}
    />
  );
}
