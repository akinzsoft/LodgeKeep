import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { Card, Button, StatusPill } from '../../shared/components/index.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import { qrOrderingApi, ApiError } from '../../shared/api/index.js';
import { guestOrderStatusTone, guestOrderStatusLabel, guestOrderPaymentTone, guestOrderPaymentLabel, isGuestOrderStillMoving } from '../status.js';
import styles from '../QrOrderScreen.module.css';
import formStyles from '../QrOrderForm.module.css';

const POLL_INTERVAL_MS = 4000;

/**
 * OrderStatusScreen — where a guest lands after placing an order (or after
 * the Paystack popup closes) and can return to at any time to check on it.
 * Polls `GET /qr-order/:token/orders/:id` on a plain interval, the same
 * "poll, don't push" pattern `NewImportTab.jsx`'s own header already
 * establishes for this codebase (no push/SSE mechanism exists anywhere in
 * this app) — the interval only runs while the order is genuinely still
 * moving (`isGuestOrderStillMoving`): payment may still complete, staff may
 * still act, or a not-yet-accepted order may still auto-reject.
 *
 * A still-`unpaid` `card` order (a reload before payment ever completed, or
 * one that never reached the gateway at all) gets a real "Complete
 * payment" section — "Retry checkout" re-attempts the gateway call fresh
 * and opens the same embedded Paystack popup `CheckoutScreen.jsx` already
 * uses; "I've already paid" re-verifies against the real gateway directly,
 * covering the case a webhook already landed but this screen hasn't polled
 * since.
 */
export function OrderStatusScreen() {
  const { token } = useOutletContext();
  const { id } = useParams();
  const navigate = useNavigate();

  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await qrOrderingApi.getOrderStatus({ token, id });
      setOrder(result);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this order.');
    }
  }, [token, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    load();
  }, [load]);

  const pollRef = useRef(null);
  useEffect(() => {
    if (order && isGuestOrderStillMoving(order.status)) {
      pollRef.current = setInterval(load, POLL_INTERVAL_MS);
      return () => clearInterval(pollRef.current);
    }
    return undefined;
  }, [order, load]);

  async function handleRetryCheckout() {
    setRetrying(true);
    setRetryError(null);
    try {
      const retried = await qrOrderingApi.retryCheckout({ token, id });
      if (retried.accessCode) {
        await openPaystackPopup({ accessCode: retried.accessCode, onClose: load });
        return;
      }
      setRetryError('Payment still could not be started. Please try again shortly.');
    } catch (caught) {
      setRetryError(caught instanceof ApiError ? caught.message : 'Could not retry payment.');
    } finally {
      setRetrying(false);
    }
  }

  async function handleConfirmPayment() {
    setConfirming(true);
    setRetryError(null);
    try {
      const result = await qrOrderingApi.confirmCardPayment({ token, id });
      setOrder(result.guestOrder);
    } catch (caught) {
      setRetryError(caught instanceof ApiError ? caught.message : 'Could not confirm payment.');
    } finally {
      setConfirming(false);
    }
  }

  if (!order && !error) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Your order</h1>
        <Card state="loading" />
      </div>
    );
  }

  if (!order && error) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Your order</h1>
        <Card>
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
          <Button onClick={load}>Try again</Button>
        </Card>
      </div>
    );
  }

  const needsPayment = order.payment_method === 'card' && order.payment_status === 'unpaid';

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Your order</h1>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <Card>
        <div className={styles.summaryList}>
          <div className={styles.summaryRow}>
            <span>Order status</span>
            <StatusPill tone={guestOrderStatusTone(order.status)} label={guestOrderStatusLabel(order.status)} />
          </div>
          <div className={styles.summaryRow}>
            <span>Payment</span>
            <StatusPill tone={guestOrderPaymentTone(order.payment_status)} label={guestOrderPaymentLabel(order.payment_status)} />
          </div>
          {order.rejected_reason && (
            <div className={styles.summaryRow}>
              <span>Reason</span>
              <span>{order.rejected_reason}</span>
            </div>
          )}
        </div>

        {order.status === 'preparing' && <p className={formStyles.hint}>The kitchen has your order and is preparing it now.</p>}
        {order.status === 'on_the_way' && <p className={formStyles.hint}>Your order is on its way.</p>}
        {(order.status === 'rejected' || order.status === 'auto_rejected') && (
          <p className={formStyles.hint}>This order was not fulfilled. Any payment already taken has been reversed in full.</p>
        )}
      </Card>

      {needsPayment && (
        <Card title="Complete payment">
          {retryError && (
            <p role="alert" className={formStyles.errorBanner}>
              {retryError}
            </p>
          )}
          <p className={formStyles.hint}>This order is on hold until payment is completed.</p>
          <div className={formStyles.actionsRow}>
            <Button onClick={handleRetryCheckout} loading={retrying}>
              Retry checkout
            </Button>
            <Button variant="secondary" onClick={handleConfirmPayment} loading={confirming}>
              I&rsquo;ve already paid
            </Button>
          </div>
        </Card>
      )}

      {order.payment_method === 'room_charge' && order.payment_status === 'unpaid' && (
        <Card>
          <p className={formStyles.hint}>This order still needs to be verified against your room.</p>
          <Button onClick={() => navigate('../room-charge', { relative: 'path' })}>Verify and charge to my room</Button>
        </Card>
      )}
    </div>
  );
}
