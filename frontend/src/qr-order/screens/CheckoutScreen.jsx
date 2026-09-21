import { useState } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney } from '../../shared/money.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import { clearCart } from '../cartStorage.js';
import { qrOrderingApi, ApiError } from '../../shared/api/index.js';
import styles from '../QrOrderScreen.module.css';
import formStyles from '../QrOrderForm.module.css';

/**
 * CheckoutScreen — collects contact details and submits the real order.
 * The cart itself lives only in `MenuScreen`'s local state and is handed
 * across via `navigate(..., {state})` (there is no backend "cart" resource
 * to persist it in, and no reload-survival is attempted — a reload here
 * simply sends the guest back to the menu to rebuild it, the honest
 * consequence of a client-only cart).
 *
 * `guest_contact` (email) is collected and required regardless of payment
 * method — a deliberate product decision, not purely a backend one: the
 * real backend (`qr-ordering/service.js`'s `createGuestOrder`) only
 * enforces a valid email for `card` payments, but a room-charge order still
 * benefits from a real contact for a receipt, so this screen asks for it
 * either way.
 *
 * ── PAYMENT, THE SAME-PAGE MECHANISM, NOT A REDIRECT ─────────────────────
 *
 * A card order's response carries a real Paystack `accessCode` in the SAME
 * response as order creation (`qr-ordering/controller.js`'s `createOrder`
 * calls `startGuestOrderCheckout` synchronously, right after creating the
 * order, before ever responding) — this screen opens that code in the
 * existing embedded, same-page Paystack popup (`shared/paystack.js`,
 * already used by the staff Cashiering screen and the booking screen's own
 * "pay at the point of booking" card) rather than a full-page redirect. No
 * `callback_url` is ever built or sent: the popup never navigates away from
 * this page at all, so there is nothing for a server-side redirect to
 * return to. On close, `confirmCardPayment` reconciles against the real
 * gateway (ARCHITECTURE.md §7 — the popup's own success event is never
 * trusted by itself) before the guest is taken to the status screen.
 *
 * A `room_charge` order settles nothing at creation time — it goes to
 * `RoomChargeConfirmScreen` next for the emailed one-time code.
 *
 * The honest 202 partial-success path (the order is real, but the gateway
 * call itself failed) is shown here with a working "Retry checkout"
 * action — the same "never silently drop a held order" precedent
 * `BookingCheckoutScreen.jsx`'s own header already establishes for the
 * identical shape.
 */
/** Names the affected item(s) in plain language for the low-stock prompt. */
function describeLowStockItems(items) {
  const names = (items ?? []).map((item) => item.name).filter(Boolean);
  if (names.length === 0) return 'One or more items may be low in stock.';
  if (names.length === 1) return `${names[0]} may be running low.`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} may be running low.`;
}

export function CheckoutScreen() {
  const { token } = useOutletContext();
  const navigate = useNavigate();
  const location = useLocation();
  const cart = location.state?.cart;
  const initialPaymentMethod = location.state?.paymentMethod;

  const [guestContact, setGuestContact] = useState('');
  const [guestName, setGuestName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [checkoutFailure, setCheckoutFailure] = useState(null);
  // Gap closure — the stock-out override guard: `caught.details.items`
  // from a `BUSINESS_RULE_INSUFFICIENT_STOCK` rejection, or `null` while
  // no such prompt is showing. A guest has no reason to type free text, so
  // this is a plain yes/no prompt — the fixed reason actually recorded in
  // the audit trail is the backend's own constant, not anything sent here.
  const [lowStockConfirm, setLowStockConfirm] = useState(null);

  if (!cart || cart.length === 0 || !initialPaymentMethod) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Your cart is empty</h1>
        <Card>
          <p role="alert" className={formStyles.errorBanner}>
            We couldn&rsquo;t find your order details — please build your order again.
          </p>
          <Button onClick={() => navigate('../menu', { relative: 'path' })}>Back to the menu</Button>
        </Card>
      </div>
    );
  }

  const total = sumMoney(cart.map((line) => multiplyMoney(line.price, line.quantity)));

  /**
   * The actual order-creation call plus its outcome handling — shared by
   * `handleSubmit` (the first attempt) and `handleConfirmLowStockOrder`
   * (the retry once the guest says "order anyway"). `acknowledgeLowStock`
   * is only ever `true` on that retry.
   */
  async function completeOrder(acknowledgeLowStock) {
    setSubmitting(true);
    setError(null);
    setCheckoutFailure(null);
    try {
      const result = await qrOrderingApi.createOrder({
        token,
        items: cart.map((line) => ({ menu_item_id: line.menuItemId, quantity: line.quantity })),
        paymentMethod: initialPaymentMethod,
        guestContact,
        guestName: guestName || undefined,
        acknowledgeLowStock,
      });
      // The order exists now; the menu should start from an empty cart next time.
      clearCart(token);

      if (initialPaymentMethod === 'room_charge') {
        navigate(`../orders/${result.id}/room-charge`, { relative: 'path' });
        return;
      }

      if (result.accessCode) {
        await openPaystackPopup({
          accessCode: result.accessCode,
          onClose: () => {
            navigate(`../orders/${result.id}/status`, { relative: 'path' });
          },
        });
        return;
      }

      // The honest 202 partial-success path — the order exists, but the
      // gateway call itself failed.
      setCheckoutFailure({ id: result.id, message: result.checkoutError ?? 'Could not start payment. Your order is on hold — try again below.' });
    } catch (caught) {
      // Gap closure — the stock-out override guard: a dedicated yes/no
      // prompt, never the generic error banner, for this one rejection.
      if (!acknowledgeLowStock && caught instanceof ApiError && caught.code === 'BUSINESS_RULE_INSUFFICIENT_STOCK') {
        setLowStockConfirm(caught.details?.items ?? []);
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not place this order.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await completeOrder(false);
  }

  async function handleConfirmLowStockOrder() {
    setLowStockConfirm(null);
    await completeOrder(true);
  }

  async function handleRetryCheckout() {
    if (!checkoutFailure) return;
    setSubmitting(true);
    setError(null);
    try {
      const retried = await qrOrderingApi.retryCheckout({ token, id: checkoutFailure.id });
      if (retried.accessCode) {
        await openPaystackPopup({
          accessCode: retried.accessCode,
          onClose: () => navigate(`../orders/${checkoutFailure.id}/status`, { relative: 'path' }),
        });
        return;
      }
      setCheckoutFailure({ ...checkoutFailure, message: 'Payment still could not be started. Please try again shortly.' });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not retry payment.');
    } finally {
      setSubmitting(false);
    }
  }

  if (checkoutFailure) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Almost there</h1>
        <Card>
          <p role="alert" className={formStyles.errorBanner}>
            {checkoutFailure.message}
          </p>
          <p className={formStyles.hint}>Your order is being held — you can retry payment now, or check its status later.</p>
          <div className={formStyles.actionsRow}>
            <Button onClick={handleRetryCheckout} loading={submitting}>
              Retry payment
            </Button>
            <Button variant="ghost" onClick={() => navigate(`../orders/${checkoutFailure.id}/status`, { relative: 'path' })}>
              View order status
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (lowStockConfirm) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>One moment</h1>
        <Card>
          {error && (
            <p role="alert" className={formStyles.errorBanner}>
              {error}
            </p>
          )}
          <p className={formStyles.hint}>{describeLowStockItems(lowStockConfirm)} We can still take your order — order anyway?</p>
          <div className={formStyles.actionsRow}>
            <Button onClick={handleConfirmLowStockOrder} loading={submitting}>
              Yes, order anyway
            </Button>
            <Button variant="ghost" onClick={() => setLowStockConfirm(null)} disabled={submitting}>
              No, go back
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Your order</h1>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <Card title="Order summary">
        <div className={styles.summaryList}>
          {cart.map((line) => (
            <div key={line.menuItemId} className={styles.summaryRow}>
              <span>
                {line.quantity} × {line.name}
              </span>
              <Money amount={multiplyMoney(line.price, line.quantity)} currencyCode="NGN" />
            </div>
          ))}
        </div>
        <div className={`${styles.summaryRow} ${styles.cartSummaryRow}`.trim()}>
          <span>Total</span>
          <Money amount={total} currencyCode="NGN" />
        </div>
        <p className={formStyles.hint}>
          {initialPaymentMethod === 'card' ? 'Paying by card.' : 'Charging to your room.'} Final price includes any applicable tax, calculated when your
          order is placed.
        </p>
      </Card>

      <Card title="Your details">
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Name (optional)</span>
            <input className={formStyles.input} value={guestName} onChange={(event) => setGuestName(event.target.value)} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Email — for your receipt</span>
            <input
              className={formStyles.input}
              type="email"
              value={guestContact}
              onChange={(event) => setGuestContact(event.target.value)}
              required
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting}>
              Place order
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
