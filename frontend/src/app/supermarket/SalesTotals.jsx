import { Money } from '../../shared/format/money.jsx';
import styles from './Supermarket.module.css';

/** How a sale was paid, as the cash-up reads it. `online_*` is a Paystack payment, by the channel the customer used. */
const METHOD_LABELS = {
  cash: 'Cash',
  terminal: 'Card (terminal)',
  online_card: 'Online: card',
  online_transfer: 'Online: bank transfer',
  online_other: 'Online: other',
};

/**
 * SalesTotals — the total of the sales in view on a supermarket sales report: the money kept (voided sales
 * excluded), how many sales that is, and how many were voided (so a void is never hidden). The numbers come
 * from the server, summed over EVERY sale in view, never from the (capped) list on screen. Below the total, the
 * same total split by how it was paid (what should be in the drawer, on the card machine, in the bank), voided excluded.
 */
export function SalesTotals({ totals, error, label, currencyCode }) {
  if (error) {
    return (
      <p className={styles.errorBanner} role="alert">
        {error}
      </p>
    );
  }
  if (!totals) return <p className={styles.hint}>Loading totals…</p>;
  const byMethod = Array.isArray(totals.byMethod) ? totals.byMethod : [];
  return (
    <>
      <div className={styles.salesTotals} role="group" aria-label={`${label} totals`}>
        <div className={styles.salesTotal}>
          <span className={styles.salesTotalLabel}>Total sales</span>
          <strong className={styles.salesTotalAmount}>
            <Money amount={totals.total} currencyCode={currencyCode} />
          </strong>
        </div>
        <div className={styles.salesTotal}>
          <span className={styles.salesTotalLabel}>Sales</span>
          <strong className={styles.salesTotalAmount}>{totals.saleCount}</strong>
        </div>
        {totals.voidedCount > 0 && (
          <div className={styles.salesTotal}>
            <span className={styles.salesTotalLabel}>Voided</span>
            <strong className={styles.salesTotalAmount}>{totals.voidedCount}</strong>
            <span className={styles.salesTotalNote}>
              <Money amount={totals.voidedTotal} currencyCode={currencyCode} /> not counted
            </span>
          </div>
        )}
      </div>
      {byMethod.length > 0 && (
        <ul className={styles.salesByMethod} aria-label={`${label} by payment method`}>
          {byMethod.map((row) => (
            <li key={row.method} className={styles.salesByMethodRow}>
              <span>{METHOD_LABELS[row.method] ?? row.method}</span>
              <strong>
                <Money amount={row.total} currencyCode={currencyCode} />
              </strong>
              <span className={styles.salesTotalNote}>
                {row.saleCount} {row.saleCount === 1 ? 'sale' : 'sales'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
