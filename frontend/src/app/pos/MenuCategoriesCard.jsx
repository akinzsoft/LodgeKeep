import { CategoryCatalogueCard } from '../../shared/components/index.js';
import { posApi } from '../../shared/api/index.js';

/**
 * MenuCategoriesCard — menu categories (Starters, Mains, Drinks…) from the
 * property's shared catalogue (20261108090000). With an outlet, the ones
 * that outlet carries (registering one here adds it to the catalogue and
 * makes this outlet carry it); without, the whole catalogue. Register,
 * rename (applied to every item using the category, and to the matching
 * stock category), reorder, and archive (refused while items still use
 * it). Changes are `pos.manage`; a lower-tier account sees the real 403.
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
export function MenuCategoriesCard({ outletId, outletName, categories, onChanged, extraRows, selectedRowKey, onSelectRow }) {
  return (
    <CategoryCatalogueCard
      title={outletName ? `Menu categories sold at ${outletName}` : 'Menu categories — all outlets'}
      hint={
        outletId
          ? 'This outlet sells every item in these categories. Adding a category here adds it to the shared catalogue and makes this outlet sell it; to choose from existing categories, use Categories sold here. Click a category to see its items below.'
          : 'The shared catalogue: categories belong to no outlet. Each outlet chooses which ones it sells under Outlets → Categories sold here, and then sells every item in them. Click a category to see its items below.'
      }
      noun="menu category"
      namePlaceholder="e.g. Starters"
      countColumnLabel="Menu items"
      renameHint="Renaming updates every menu item in this menu category."
      archiveConsequence="will no longer be offered for menu items. A menu category still used by menu items cannot be archived — move those items first."
      categories={categories}
      onChanged={onChanged}
      api={{ create: (payload) => posApi.createMenuCategory({ ...payload, outletId }), update: posApi.updateMenuCategory, archive: posApi.archiveMenuCategory }}
      extraRows={extraRows}
      selectedRowKey={selectedRowKey}
      onSelectRow={onSelectRow}
    />
  );
}
