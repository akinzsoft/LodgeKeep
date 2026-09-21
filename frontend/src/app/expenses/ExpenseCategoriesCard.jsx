import { CategoryCatalogueCard } from '../../shared/components/index.js';
import { expensesApi } from '../../shared/api/index.js';

/**
 * ExpenseCategoriesCard — mirrors `StockCategoriesCard.jsx`'s exact CRUD
 * shape. Register, rename, reorder, and archive (refused while any
 * non-voided expense or active recurring schedule still uses it).
 * Unlike stock's own copied-name-string categories, `expense_category_id`
 * is a real, live foreign key — a rename needs no cascade explanation,
 * since the join always resolves the current name automatically.
 *
 * A thin wrapper around the shared `CategoryCatalogueCard` — see that
 * component's own header for why (this was one of three near-identical,
 * independently hand-built cards before this refactor). `renameHint` is
 * omitted (`null`) for exactly the reason above — no cascade happens here.
 */
export function ExpenseCategoriesCard({ categories, onChanged }) {
  return (
    <CategoryCatalogueCard
      title="Expense categories"
      hint="Categories are shared across every expense and recurring schedule at this property."
      namePlaceholder="e.g. Utilities"
      countColumnLabel="Expenses"
      renameHint={null}
      archiveConsequence="will no longer be offered when recording an expense or a recurring schedule. A category still in use cannot be archived — move those items first."
      categories={categories}
      onChanged={onChanged}
      api={{ create: expensesApi.createExpenseCategory, update: expensesApi.updateExpenseCategory, archive: expensesApi.archiveExpenseCategory }}
    />
  );
}
