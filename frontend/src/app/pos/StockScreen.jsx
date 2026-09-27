import { StockTab } from './StockTab.jsx';
import styles from './POSScreen.module.css';

/**
 * StockScreen — the stock screens on their own, for a role that moves stock
 * but does not sell (the Storekeeper: `pos.stock_view` + `pos.stock_transfer`,
 * no `pos.operate`). The same `StockTab` POS → Stock shows, filtered to the
 * tabs the role's grants reach.
 */
export function StockScreen({ activeProperty, isOffline = false, permissions }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Stock</h1>
      {!activeProperty ? (
        <p className={styles.loading}>Choose a property from the Property box in the top bar to manage stock.</p>
      ) : (
        <StockTab activeProperty={activeProperty} isOffline={isOffline} permissions={permissions} />
      )}
    </div>
  );
}
