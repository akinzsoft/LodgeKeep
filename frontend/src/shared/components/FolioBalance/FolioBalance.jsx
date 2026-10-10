import { Money, folioBalanceKind, absoluteBalance } from '../../format/money.jsx';
import styles from './FolioBalance.module.css';

/**
 * A folio balance, labelled by which side of zero it is on, so a CREDIT (a
 * deposit with money left, which the hotel owes back) is never shown as a debt:
 *   owed   -> "Outstanding ₦X"  (red)
 *   credit -> "Credit ₦X"       (green)
 *   zero   -> the plain amount
 * The words carry the meaning; the colour only reinforces it (DESIGN_SYSTEM.md:
 * never colour alone). The balance itself is passed through untouched.
 */
export function FolioBalance({ amount, currencyCode }) {
  const kind = folioBalanceKind(amount);
  if (kind === 'owed') {
    return (
      <span className={styles.owed}>
        Outstanding <Money amount={amount} currencyCode={currencyCode} />
      </span>
    );
  }
  if (kind === 'credit') {
    return (
      <span className={styles.credit}>
        Credit <Money amount={absoluteBalance(amount)} currencyCode={currencyCode} />
      </span>
    );
  }
  return <Money amount={amount} currencyCode={currencyCode} />;
}
