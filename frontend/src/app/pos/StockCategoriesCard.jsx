import { CategoryCatalogueCard } from '../../shared/components/index.js';
import { stockApi } from '../../shared/api/index.js';

/**
 * StockCategoriesCard — gap closure, mirrors `MenuCategoriesCard.jsx`
 * exactly: the property's registered stock-item categories (Wine,
 * Spirits, Produce…), shared by every outlet. Stock items pick one from a
 * dropdown fed by this list. Register, rename (applied to every stock item
 * using the category), reorder, and archive (refused while items still
 * use it). Changes are `pos.stock_manage`; a lower-tier account sees the
 * real 403.
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
export function StockCategoriesCard({ categories, onChanged, extraRows, selectedRowKey, onSelectRow }) {
  return (
    <CategoryCatalogueCard
      title="Stock categories"
      hint="Stock categories group what you hold in storage, and are shared by every outlet. They are separate from menu categories, which group what guests buy. Stock items choose one of these, so the Stock Items list shows consistent names. Click a stock category to see its items below."
      noun="stock category"
      namePlaceholder="e.g. Wine"
      countColumnLabel="Stock items"
      renameHint="Renaming updates every stock item in this stock category."
      archiveConsequence="will no longer be offered for stock items. A stock category still used by stock items cannot be archived — move those items first."
      categories={categories}
      onChanged={onChanged}
      api={{ create: stockApi.createStockItemCategory, update: stockApi.updateStockItemCategory, archive: stockApi.archiveStockItemCategory }}
      extraRows={extraRows}
      selectedRowKey={selectedRowKey}
      onSelectRow={onSelectRow}
    />
  );
}
