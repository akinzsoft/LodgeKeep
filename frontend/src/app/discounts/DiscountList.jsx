import { Money } from '../../shared/format/money.jsx';
import { STATUS_LABELS, describeRule } from './discountText.js';
import styles from './DiscountDialog.module.css';

/**
 * The discounts on a check or a cart: what each is, why, its state, and what it takes off (once applied). A waiting
 * one offers "Approve" (a manager's PIN); a live one can be removed before the sale. Shown only when there are any.
 *
 * @param {Array} discounts  `discountsApi` rows (`id, scope, kind, type, value, status, reason_name, amount`).
 * @param {(discount) => void} onApprove
 * @param {(discount) => void} onRemove
 */
export function DiscountList({ discounts, currencyCode, lineLabel, onApprove, onRemove, disabled = false }) {
  if (!discounts || discounts.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Discounts on this sale">
      {discounts.map((discount) => (
        <li key={discount.id} className={styles.item}>
          <span className={styles.itemText}>
            <span>
              {describeRule(discount, (amount) => <Money amount={amount} currencyCode={currencyCode} />)} · {discount.reason_name}
              {discount.scope === 'line' && lineLabel ? ` · ${lineLabel(discount)}` : ''}
            </span>
            <span className={styles.itemMeta}>
              {STATUS_LABELS[discount.status] ?? discount.status}
              {discount.amount ? <> · takes off <Money amount={discount.amount} currencyCode={currencyCode} /></> : null}
            </span>
          </span>
          <span className={styles.itemActions}>
            {discount.status === 'pending_approval' && onApprove && (
              <button type="button" className={styles.linkButton} disabled={disabled} onClick={() => onApprove(discount)}>
                Approve
              </button>
            )}
            {onRemove && (
              <button type="button" className={styles.linkButton} disabled={disabled} onClick={() => onRemove(discount)} aria-label={`Remove the ${discount.reason_name} discount`}>
                Remove
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
