import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { supermarketApi, ApiError } from '../../shared/api/index.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import styles from './OnlineCard.module.css';

const POLL_MS = 4000;

/**
 * OnlineCardDialog — the supermarket till's "Card (online)" payment. The sale is
 * only PENDING here: the server completes it (receipt, stock, settlement) the
 * moment Paystack reports the payment, whether the webhook or this dialog's
 * own check sees it first, so a customer who has paid is never left without a
 * recorded sale. The customer pays either in this window (Paystack's popup) or
 * by scanning the QR code with their own phone.
 *
 * `session`: `{intent, accessCode, checkoutUrl, qrDataUrl, checkoutError}` from
 * `startOnlineSale` (or the reopened pending sale). `onCompleted(sale)` hands
 * back the finished sale for the receipt; `onClose()` leaves a sale that is
 * cancelled, flagged for a refund, or that the cashier chose to keep waiting.
 *
 * The dialog never trusts the popup's own success: every close and every poll
 * asks the server, which asks Paystack. A Paystack outage shows a notice and
 * leaves the sale waiting (nothing is cancelled on a guess).
 */
export function OnlineCardDialog({ session, currency, isOffline = false, onCompleted, onClose }) {
  const [intent, setIntent] = useState(session.intent);
  const [checkout, setCheckout] = useState({ accessCode: session.accessCode ?? null, checkoutUrl: session.checkoutUrl ?? null, qrDataUrl: session.qrDataUrl ?? null });
  const [notice, setNotice] = useState(session.checkoutError ? `Paystack could not be reached: ${session.checkoutError}` : null);
  const [busy, setBusy] = useState(false);
  const completed = useRef(false);
  const requestId = useRef(0);

  const adopt = useCallback((next) => {
    setIntent(next);
    if (next.status === 'completed' && next.sale && !completed.current) {
      completed.current = true;
      onCompleted(next.sale);
    }
  }, [onCompleted]);

  const check = useCallback(async ({ quiet = false } = {}) => {
    const id = (requestId.current += 1);
    try {
      const { intent: next, checkError } = await supermarketApi.checkOnlineSale(intent.id);
      if (id !== requestId.current) return; // a newer check or action superseded this answer
      adopt(next);
      if (checkError) setNotice(`Could not check with Paystack just now (${checkError}). The sale is still waiting.`);
      else if (!quiet || next.status !== 'pending') setNotice(null);
    } catch (caught) {
      if (id !== requestId.current) return;
      setNotice(caught instanceof ApiError ? caught.message : 'Could not check the payment.');
    }
  }, [intent.id, adopt]);

  useEffect(() => {
    if (intent.status !== 'pending' || isOffline) return undefined;
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') check({ quiet: true }); }, POLL_MS);
    return () => clearInterval(timer);
  }, [intent.status, isOffline, check]);

  async function handlePay() {
    if (!checkout.accessCode) return;
    try {
      await openPaystackPopup({ accessCode: checkout.accessCode, onClose: () => check() });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not open the payment window.');
    }
  }

  async function handleRetryCheckout() {
    setBusy(true);
    try {
      const reopened = await supermarketApi.reopenOnlineCheckout(intent.id);
      adopt(reopened.intent);
      setCheckout({ accessCode: reopened.accessCode ?? null, checkoutUrl: reopened.checkoutUrl ?? null, qrDataUrl: reopened.qrDataUrl ?? null });
      setNotice(reopened.checkoutError ? `Paystack could not be reached: ${reopened.checkoutError}` : null);
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : 'Could not reopen the payment.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    requestId.current += 1;
    try {
      adopt(await supermarketApi.cancelOnlineSale(intent.id, 'Cancelled at the till.'));
      setNotice(null);
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : 'Could not cancel. The sale is still waiting.');
    } finally {
      setBusy(false);
    }
  }

  const pending = intent.status === 'pending';
  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="online-card-title">
        <h2 id="online-card-title" className={styles.title}>Card payment (online)</h2>
        <p className={styles.total}><Money amount={intent.total} currencyCode={currency ?? intent.currency} /></p>

        {pending && (
          <>
            <p className={styles.hint}>The customer can pay in this window, or scan the code with their phone. The sale completes by itself once the payment arrives.</p>
            {checkout.qrDataUrl && <img className={styles.qr} src={checkout.qrDataUrl} alt="Scan to pay by card" />}
            <div className={styles.actions}>
              {checkout.accessCode && <Button onClick={handlePay} disabled={isOffline || busy}>Pay in this window</Button>}
              {!checkout.accessCode && <Button onClick={handleRetryCheckout} disabled={isOffline || busy}>Try again</Button>}
              <Button variant="secondary" onClick={() => check()} disabled={isOffline || busy}>Check payment</Button>
              <Button variant="secondary" onClick={handleCancel} disabled={isOffline || busy}>Cancel payment</Button>
            </div>
            <p className={styles.waiting} role="status">Waiting for payment…</p>
          </>
        )}

        {intent.status === 'cancelled' && (
          <>
            <p className={styles.hint} role="status">This sale was cancelled{intent.cancel_reason ? ` (${intent.cancel_reason})` : ''}. Nothing was charged. The cart is still on the till.</p>
            <div className={styles.actions}><Button onClick={onClose}>Close</Button></div>
          </>
        )}

        {intent.status === 'needs_review' && (
          <>
            <p className={styles.errorBanner} role="alert">The customer&apos;s payment was received but the sale could not be completed ({intent.review_reason}). Do not hand over the goods. A manager has been alerted and must refund it on the Supermarket screen.</p>
            <div className={styles.actions}><Button onClick={onClose}>Close</Button></div>
          </>
        )}

        {notice && <p className={styles.errorBanner} role="alert">{notice}</p>}
        {pending && isOffline && <p className={styles.hint}>You are offline. Checking resumes when you are back online.</p>}
        {pending && <button type="button" className={styles.keepWaiting} onClick={onClose}>Close and keep waiting</button>}
      </div>
    </div>
  );
}
