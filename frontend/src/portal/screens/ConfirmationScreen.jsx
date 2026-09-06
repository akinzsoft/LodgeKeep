import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { Card, Button, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { portalApi, ApiError } from '../../shared/api/index.js';
import { statusTone, statusLabel } from '../../app/booking/status.js';
import { useBranding } from '../branding/BrandingContext.jsx';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/**
 * ConfirmationScreen — where the guest's browser lands both coming back
 * from Paystack (`callback_base_url` in `portal/service.js`'s
 * `createBookingWithPayment`) and from an emailed confirmation link.
 * `confirmBookingPayment` is safe to call on every mount regardless of
 * which one brought the guest here — it re-verifies against the real
 * gateway and is a no-op once the reservation is no longer `tentative`
 * (`portal/service.js`'s own header explains why this makes repeated calls
 * safe). `statusTone`/`statusLabel` are reused from the staff booking
 * module rather than a second copy of that vocabulary — the reservation
 * status enum is the same one everywhere in this codebase.
 */
export function ConfirmationScreen() {
  const { propertySlug } = useOutletContext();
  const { confirmationNumber } = useParams();
  const { branding } = useBranding();
  const currencyCode = branding?.baseCurrency ?? 'USD';

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const confirm = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await portalApi.confirmBookingPayment({ propertySlug, confirmationNumber }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not confirm this booking.');
    } finally {
      setLoading(false);
    }
  }, [propertySlug, confirmationNumber]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    confirm();
  }, [confirm]);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Booking confirmation</h1>

      {loading && <Card state="loading" />}

      {!loading && error && (
        <Card>
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
          <div className={formStyles.actionsRow}>
            <Button onClick={confirm}>Try again</Button>
          </div>
        </Card>
      )}

      {!loading && !error && result && (
        <Card>
          <dl className={formStyles.form}>
            <div>
              <dt className={formStyles.label}>Confirmation number</dt>
              <dd>{result.reservation.confirmation_number}</dd>
            </div>
            <div>
              <dt className={formStyles.label}>Booking status</dt>
              <dd>
                <StatusPill tone={statusTone(result.reservation.status)} label={statusLabel(result.reservation.status)} />
              </dd>
            </div>
            <div>
              <dt className={formStyles.label}>Dates</dt>
              <dd>
                {result.reservation.arrival_date} → {result.reservation.departure_date}
              </dd>
            </div>
            <div>
              <dt className={formStyles.label}>Payment</dt>
              <dd>
                <StatusPill tone={result.payment.status === 'CAPTURED' ? 'success' : result.payment.status === 'FAILED' ? 'danger' : 'neutral'} label={result.payment.status} />{' '}
                <Money amount={result.payment.amount} currencyCode={currencyCode} />
              </dd>
            </div>
          </dl>

          {result.reservation.status === 'confirmed' && <p>You&rsquo;re all set — a confirmation email is on its way.</p>}
          {result.reservation.status === 'cancelled' && <p>Payment was not successful, so this booking was released. No charge was made.</p>}
          {result.reservation.status === 'tentative' && <p>We&rsquo;re still confirming your payment — refresh in a moment.</p>}

          <div className={formStyles.actionsRow}>
            <Link className={formStyles.link} to={`/portal/${propertySlug}`}>
              Back to {branding?.name ?? 'the property'}
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}
