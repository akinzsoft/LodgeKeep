import { paymentLabel } from './paymentLabel.js';
import { Money } from '../../shared/format/money.jsx';
import styles from './Supermarket.module.css';

/**
 * A receipt for one quick sale: the stored snapshot, so it reads the same
 * whenever it is reprinted and whatever the product is later renamed or
 * repriced. Shown on screen after a sale and, through `PrintDocument`, on paper.
 */
export function SupermarketReceipt({ sale, property }) {
  const currency = sale.currency ?? property?.base_currency;
  const voided = Boolean(sale.voided_at);
  return (
    <div className={styles.receipt} data-testid="supermarket-receipt">
      <h3 className={styles.receiptTitle}>{property?.name ?? 'Receipt'}</h3>
      <p className={styles.receiptMeta}>
        {sale.outlet_name} · Receipt {sale.receipt_code}
        <br />
        {new Date(sale.created_at).toLocaleString()}
        {sale.sold_by_name ? ` · ${sale.sold_by_name}` : ''}
      </p>
      {voided && <p className={styles.voidedNotice}>VOIDED</p>}
      <table className={styles.receiptTable}>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className={styles.num}>Qty</th>
            <th scope="col" className={styles.num}>Price</th>
            <th scope="col" className={styles.num}>Total</th>
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((line) => (
            <tr key={line.id ?? line.line_no}>
              <td>{line.item_name}</td>
              <td className={styles.num}>{line.quantity}</td>
              <td className={styles.num}><Money amount={line.unit_price} currencyCode={currency} /></td>
              <td className={styles.num}><Money amount={line.line_total} currencyCode={currency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className={styles.totals}>
        <div><dt>Subtotal</dt><dd><Money amount={sale.subtotal} currencyCode={currency} /></dd></div>
        <div><dt>Tax</dt><dd><Money amount={sale.tax_amount} currencyCode={currency} /></dd></div>
        <div className={styles.grandTotal}><dt>Total</dt><dd><Money amount={sale.total} currencyCode={currency} /></dd></div>
        <div><dt>Paid by</dt><dd>{paymentLabel(sale)}</dd></div>
      </dl>
    </div>
  );
}
