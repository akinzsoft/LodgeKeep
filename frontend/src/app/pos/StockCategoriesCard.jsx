import { CategoryCatalogueCard } from '../../shared/components/index.js';
import { stockApi } from '../../shared/api/index.js';
import { menuCategoryForStockCategory } from './sellInRegister.js';

/**
 * Registering a stock category for an outlet also registers it as that
 * outlet's own menu category (user-requested), matching the reverse
 * bridge `sellInRegister.js`'s `stockCategoryForMenuCategory` already
 * does when a menu item gets a linked stock item. Best-effort and never
 * blocks the stock category itself: a role holding `pos.stock_manage` but
 * not `pos.manage` (a real, distinct grant) genuinely cannot create the
 * menu-side category, and the stock category the user actually asked for
 * must still be created regardless. The menu category is picked up the
 * next time Setup's own list reloads.
 */
async function createStockCategoryAndMirror(payload, outletId) {
  const category = await stockApi.createStockItemCategory({ ...payload, outletId });
  try {
    await menuCategoryForStockCategory(category.name, outletId);
  } catch {
    // Best-effort — see this function's own header. The stock category
    // above is real regardless; a menu item can still bridge the other
    // way later (`stockCategoryForMenuCategory`), or Setup's own Menu
    // categories card can register it directly.
  }
  return category;
}

/**
 * StockCategoriesCard — gap closure, mirrors `MenuCategoriesCard.jsx`
 * exactly: ONE outlet's registered stock-item categories (Wine, Spirits,
 * Produce…); another outlet keeps its own list, even for the same name
 * (20261105090000). Stock items pick one from a
 * dropdown fed by this list. Register, rename (applied to every stock item
 * using the category), reorder, and archive (refused while items still
 * use it). Changes are `pos.stock_manage`; a lower-tier account sees the
 * real 403. Registering a category also mirrors it into that outlet's own
 * menu categories — see `createStockCategoryAndMirror`'s own header.
 *
 * A thin wrapper around the shared `CategoryCatalogueCard` — see that
 * component's own header for why (this was one of three near-identical,
 * independently hand-built cards before this refactor).
 *
 * `extraRows`/`selectedRowKey`/`onSelectRow` thread straight through to
 * `CategoryCatalogueCard`'s own opt-in row-selection mode — see that
 * component's header. `StockItemsTab` is this card's one caller that uses
 * it, for its single-selected-category items view.
 */
export function StockCategoriesCard({ outletId, outletName, categories, onChanged, extraRows, selectedRowKey, onSelectRow }) {
  return (
    <CategoryCatalogueCard
      title={outletName ? `Stock categories — ${outletName}` : 'Stock categories'}
      hint="Stock categories group what you hold in storage, and belong to this outlet only — another outlet keeps its own list, even if it uses the same names. They are separate from menu categories, which group what guests buy. Stock items choose one of these, so the Stock Items list shows consistent names. Click a stock category to see its items below."
      noun="stock category"
      namePlaceholder="e.g. Wine"
      countColumnLabel="Stock items"
      renameHint="Renaming updates every stock item in this stock category."
      archiveConsequence="will no longer be offered for stock items. A stock category still used by stock items cannot be archived — move those items first."
      categories={categories}
      onChanged={onChanged}
      api={{ create: (payload) => createStockCategoryAndMirror(payload, outletId), update: stockApi.updateStockItemCategory, archive: stockApi.archiveStockItemCategory }}
      extraRows={extraRows}
      selectedRowKey={selectedRowKey}
      onSelectRow={onSelectRow}
    />
  );
}
