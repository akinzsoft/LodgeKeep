import { useCallback, useEffect, useState } from 'react';
import { ExpenseCategoriesCard } from './ExpenseCategoriesCard.jsx';
import { RecordExpenseTab } from './RecordExpenseTab.jsx';
import { RecurringTab } from './RecurringTab.jsx';
import { ReportsTab } from './ReportsTab.jsx';
import { expensesApi, ApiError } from '../../shared/api/index.js';
import styles from './ExpensesScreen.module.css';

/**
 * ExpensesScreen — expense tracking and reporting (a greenfield feature,
 * no PLAN.md phase or PRODUCT_REQUIREMENTS.md section names this module).
 * Four tabs, the same self-contained multi-tab pattern `ARScreen`/
 * `POSScreen` already established — no router in this app yet. Filed
 * under SETUP in `nav-config.js` (back-office, gated on `expenses.view`),
 * next to Night Audit/AR/Billing — a manager-tier financial screen, not a
 * front-line operational one.
 *
 * Categories are fetched once here and threaded down to both the
 * Categories card and the Record/Recurring forms' own category pickers —
 * the same "select once, act across tabs" idiom `RoomsScreen`/
 * `CashieringScreen` already use.
 */
const TABS = [
  { key: 'categories', label: 'Categories' },
  { key: 'record', label: 'Record Expense' },
  { key: 'recurring', label: 'Recurring' },
  { key: 'reports', label: 'Reports' },
];

export function ExpensesScreen({ activeProperty, isOffline = false }) {
  const [tab, setTab] = useState('categories');
  const [categories, setCategories] = useState(null);
  const [categoriesError, setCategoriesError] = useState(null);

  const reloadCategories = useCallback(async () => {
    try {
      setCategories(await expensesApi.listExpenseCategories());
      setCategoriesError(null);
    } catch (caught) {
      setCategoriesError(caught instanceof ApiError ? caught.message : 'Could not load expense categories.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadCategories();
  }, [reloadCategories]);

  return (
    <div className={styles.page}>
      <h1 className={`${styles.title} ${styles.noPrint}`.trim()}>Expenses</h1>

      <div className={`${styles.tabs} ${styles.noPrint}`.trim()} role="tablist" aria-label="Expenses sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`.trim()}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {categoriesError && (
        <p role="alert" className={`${styles.panel} ${styles.noPrint}`.trim()}>
          {categoriesError}
        </p>
      )}

      <div className={styles.panel}>
        {tab === 'categories' && <ExpenseCategoriesCard categories={categories} onChanged={reloadCategories} />}
        {tab === 'record' && (
          <RecordExpenseTab categories={categories} activeProperty={activeProperty} isOffline={isOffline} onExpenseRecorded={reloadCategories} />
        )}
        {tab === 'recurring' && <RecurringTab categories={categories} activeProperty={activeProperty} isOffline={isOffline} />}
        {tab === 'reports' && <ReportsTab activeProperty={activeProperty} />}
      </div>
    </div>
  );
}
