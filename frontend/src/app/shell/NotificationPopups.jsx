import { Button } from '../../shared/components/index.js';
import { formatMoney } from '../../shared/format/money.jsx';
import { parsePayload, timeAgo } from './notificationText.js';
import styles from './NotificationPopups.module.css';

const MAX_VISIBLE = 3;

function paymentLabel(method) {
  if (method === 'room_charge') return 'Charged to room';
  if (method === 'card') return 'Paid by card';
  return null;
}

/**
 * The on-screen card for a new guest QR order (gap closure: staff
 * notifications — "if guest QR ordered it should prompt a standard UI card
 * with the message for who ordered").
 *
 * Not a `Toast`: DESIGN_SYSTEM.md §2 keeps toasts to transient success
 * confirmation, and this card carries several lines (who, where, what, how
 * much) plus a primary action. It is also not modal — a bartender can keep
 * working, and it stays until acted on rather than vanishing mid-rush.
 * "View orders" opens the POS screen and marks it read; "Dismiss" only hides
 * the card, leaving it unread in the bell.
 *
 * @param {Array<object>} popups           newest first
 * @param {(notification: object) => void} [onView]   omitted when the user can't open POS
 * @param {(id: string) => void} onDismiss
 */
export function NotificationPopups({ popups, onView, onDismiss }) {
  if (!popups || popups.length === 0) return null;
  const visible = popups.slice(0, MAX_VISIBLE);
  const hiddenCount = popups.length - visible.length;

  return (
    <div className={styles.stack} aria-live="assertive" aria-relevant="additions">
      {visible.map((notification) => {
        const p = parsePayload(notification);
        const items = Array.isArray(p.items) ? p.items : [];
        const where = [p.tableLabel, p.outletName].filter(Boolean).join(' · ');
        return (
          <section key={notification.id} className={styles.card} role="alert" aria-label="New QR order">
            <header className={styles.header}>
              <span className={styles.badge} aria-hidden="true">
                QR
              </span>
              <div className={styles.headingText}>
                <h2 className={styles.title}>New QR order</h2>
                {where && <p className={styles.where}>{where}</p>}
              </div>
              <span className={styles.time}>{timeAgo(notification.created_at)}</span>
            </header>

            <p className={styles.who}>
              Ordered by <strong>{p.guestName || 'a guest'}</strong>
            </p>

            {items.length > 0 && (
              <ul className={styles.items}>
                {items.slice(0, 4).map((item, index) => (
                  <li key={`${item.name}-${index}`} className={styles.item}>
                    <span className={styles.qty}>{item.quantity}×</span>
                    <span className={styles.itemName}>{item.name}</span>
                  </li>
                ))}
                {items.length > 4 && <li className={styles.more}>+{items.length - 4} more</li>}
              </ul>
            )}

            <div className={styles.totalRow}>
              <span className={styles.payment}>{paymentLabel(p.paymentMethod)}</span>
              {p.total && p.currency && <span className={styles.total}>{formatMoney(p.total, p.currency)}</span>}
            </div>

            <div className={styles.actions}>
              <Button variant="secondary" size="compact" onClick={() => onDismiss(notification.id)}>
                Dismiss
              </Button>
              {onView && (
                <Button size="compact" onClick={() => onView(notification)}>
                  View orders
                </Button>
              )}
            </div>
          </section>
        );
      })}
      {hiddenCount > 0 && <p className={styles.overflow}>+{hiddenCount} more new orders in the bell</p>}
    </div>
  );
}
