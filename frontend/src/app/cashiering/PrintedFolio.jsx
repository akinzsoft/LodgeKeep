import { PrintLetterhead } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatDate } from '../../shared/format/dates.js';
import styles from './PrintedFolio.module.css';

const TYPE_LABELS = {
  room_charge: 'Room charge',
  tax: 'Tax',
  pos_charge: 'POS charge',
  payment: 'Payment',
  refund: 'Refund',
  adjustment: 'Adjustment',
};

/**
 * The guest folio as a printed document (user-requested): the property's
 * letterhead and logo watermark, then every line that stands — voided lines
 * are left off, as they never counted — and the balance. Shown only while
 * printing, through `PrintDocument`, so nothing on screen changes.
 */
export function PrintedFolio({ folio, lineItems, property }) {
  const lines = (lineItems ?? []).filter((line) => !line.voided_at);
  return (
    <div className={styles.folio}>
      <PrintLetterhead
        logoUrl={property?.logo_url}
        organisation={property?.name}
        title="Guest folio"
        details={[`Folio ${folio.folio_number} · ${folio.billed_to}`, `Printed ${new Date().toLocaleString()}`]}
      />
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Description</th>
            <th scope="col">Type</th>
            <th scope="col" className={styles.amount}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && (
            <tr>
              <td colSpan={4}>No charges posted.</td>
            </tr>
          )}
          {lines.map((line) => (
            <tr key={line.id}>
              <td className={styles.nowrap}>{formatDate(line.business_date)}</td>
              <td>{line.description}</td>
              <td>{TYPE_LABELS[line.type] ?? line.type}</td>
              <td className={styles.amount}>
                <Money amount={line.amount} currencyCode={folio.currency} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={styles.total}>
            <td colSpan={3}>Balance</td>
            <td className={styles.amount}>
              <Money amount={folio.balance} currencyCode={folio.currency} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
