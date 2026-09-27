import { CategoryCatalogueCard } from '../../shared/components/index.js';
import { stockApi } from '../../shared/api/index.js';
/**
 * StockCategoriesCard — the stock categories an outlet carries (Wine,
 * Spirits, Produce…). Categories are shared by the whole property and hold
 * the same names as the menu categories (shared catalogue, 20261108090000);
 * an outlet shows the ones it carries. Registering one here adds it to the
 * property and makes this outlet carry it. Register, rename (applied to
 * every stock item using the category, and to the matching menu category),
 * reorder, and archive (refused while items still use it). Changes are
 * `pos.stock_manage`; a lower-tier account sees the real 403.
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
      hint="Stock categories group what you hold in storage. They are shared by every outlet and match the menu categories in POS → Setup; this list shows the ones this outlet carries, and adding one here makes this outlet carry it. Click a stock category to see its items below."
      noun="stock category"
      namePlaceholder="e.g. Wine"
      countColumnLabel="Stock items"
      renameHint="Renaming updates every stock item in this stock category."
      archiveConsequence="will no longer be offered for stock items. A stock category still used by stock items cannot be archived — move those items first."
      categories={categories}
      onChanged={onChanged}
      api={{ create: (payload) => stockApi.createStockItemCategory({ ...payload, outletId }), update: stockApi.updateStockItemCategory, archive: stockApi.archiveStockItemCategory }}
      extraRows={extraRows}
      selectedRowKey={selectedRowKey}
      onSelectRow={onSelectRow}
    />
  );
}
