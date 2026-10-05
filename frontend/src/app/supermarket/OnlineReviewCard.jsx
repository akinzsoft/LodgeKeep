import { useCallback, useEffect, useState } from 'react';
import { Card, Button, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { supermarketApi, ApiError } from '../../shared/api/index.js';
import styles from './Supermarket.module.css';

/**
 * OnlineReviewCard — Supermarket → Setup (manager): online card payments that
 * were RECEIVED but could not become a sale (paid after the cashier cancelled
 * or the sale expired, or the tax changed while the customer paid). The money
 * is kept, never dropped; a manager refunds it here (the full amount, with a
 * reason). Hidden while there is nothing to review.
 */
export function OnlineReviewCard({ outletId, isOffline = false }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      setRows(await supermarketApi.listOnlineSalesNeedingReview(outletId));
      setError(null);
    } catch (caught) {
      setRows([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load online payments needing a refund.');
    }
  }, [outletId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet change
    load();
  }, [load]);

  async function handleRefund(reason) {
    const row = target;
    setTarget(null);
    try {
      await supermarketApi.refundOnlineSale(row.id, reason);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The refund could not be sent.');
    }
  }

  if (rows === null || (rows.length === 0 && !error)) return null;
  return (
    <Card title="Online payments needing a refund">
      {error && <p className={styles.errorBanner} role="alert">{error}</p>}
      <p className={styles.hint}>These customers paid online (Paystack) but no sale was recorded. Refund them in full.</p>
      <ul className={styles.setupList} aria-label="Online payments needing a refund">
        {rows.map((row) => (
          <li key={row.id} className={styles.setupRow}>
            <span className={styles.setupName}><Money amount={row.total} currencyCode={row.currency} /> — {row.lines.map((line) => `${line.quantity} × ${line.item_name}`).join(', ')}</span>
            <span className={styles.hint}>{row.review_reason}</span>
            <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => setTarget(row)}>Refund</Button>
          </li>
        ))}
      </ul>
      {target && (
        <ConfirmDialog
          title="Refund this online payment?"
          consequence="The full amount goes back to the customer's card through Paystack. This cannot be undone."
          requireReason
          confirmLabel="Refund customer"
          onConfirm={handleRefund}
          onCancel={() => setTarget(null)}
        />
      )}
    </Card>
  );
}
