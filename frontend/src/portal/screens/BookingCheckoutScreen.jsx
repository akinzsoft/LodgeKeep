import { useState } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { portalApi, ApiError } from '../../shared/api/index.js';
import { useBranding } from '../branding/BrandingContext.jsx';
import { useGuestAuth } from '../auth/GuestAuthContext.jsx';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/**
 * BookingCheckoutScreen — PRODUCT_REQUIREMENTS.md §3.14/§3.16: dates and a
 * room type come in from the search screen's own query params (no
 * server-side "hold this room type while I fill out a form" state exists,
 * so the params ARE the hold, re-sent whole on submit); guest details are
 * collected here (skipped when a real account is already signed in) and
 * the whole thing is submitted as one booking+payment-intent call
 * (`portal/service.js`'s `createBookingWithPayment`).
 *
 * `rate_code_id` is never a URL param — this screen resolves it the same
 * way `portal/service.js`'s own header documents as this pass's honest
 * stand-in for "the standard rate": the first active rate code, sorted by
 * code (`listRateCodes`'s own ordering).
 *
 * A successful submission returns a real Paystack `authorizationUrl` most
 * of the time, which this screen redirects the whole browser to — a
 * gateway checkout page is not something a SPA route can render inline.
 * The honest-202-partial-success path (`portal/controller.js`'s own
 * `respondWithCheckout`: the booking exists, but the Paystack call itself
 * failed) is shown as a real error with a working retry, never silently
 * dropped — the booking already holds inventory and must not be abandoned
 * without the guest knowing why.
 *
 * No offline handling is threaded through this screen — a booking payment
 * is inherently an online-only action (it ends in a redirect to an
 * external gateway), unlike the staff app's mutations this codebase's
 * `isOffline` prop exists to guard.
 */
export function BookingCheckoutScreen() {
  const { propertySlug } = useOutletContext();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { branding } = useBranding();
  const { isAuthenticated, guest } = useGuestAuth();
  const currencyCode = branding?.baseCurrency ?? 'USD';

  const roomTypeId = searchParams.get('room_type_id');
  const roomTypeName = searchParams.get('room_type_name') ?? 'Selected room';
  const rate = searchParams.get('rate');
  const arrivalDate = searchParams.get('arrival_date');
  const departureDate = searchParams.get('departure_date');
  const adults = searchParams.get('adults') ?? '1';
  const children = searchParams.get('children') ?? '0';

  const missingDetails = !roomTypeId || !arrivalDate || !departureDate;

  const [guestForm, setGuestForm] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [checkoutFailure, setCheckoutFailure] = useState(null);

  async function resolveRateCodeId() {
    const rateCodes = await portalApi.listRateCodes(propertySlug);
    if (rateCodes.length === 0) {
      throw new ApiError({ code: 'VALIDATION_NO_RATE_CODES', message: 'This property has no active rate plans configured yet.' });
    }
    return rateCodes[0].id;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setCheckoutFailure(null);
    try {
      const rateCodeId = await resolveRateCodeId();
      const callbackBaseUrl = `${window.location.origin}/portal/${propertySlug}/confirmation`;
      const booking = isAuthenticated
        ? await portalApi.createAccountBooking({ propertySlug, roomTypeId, rateCodeId, arrivalDate, departureDate, adults, children, callbackBaseUrl })
        : await portalApi.createAnonymousBooking({
            propertySlug,
            roomTypeId,
            rateCodeId,
            arrivalDate,
            departureDate,
            adults,
            children,
            firstName: guestForm.first_name,
            lastName: guestForm.last_name,
            email: guestForm.email,
            phone: guestForm.phone || undefined,
            callbackBaseUrl,
          });

      if (booking.authorizationUrl) {
        window.location.assign(booking.authorizationUrl);
        return;
      }

      setCheckoutFailure({
        confirmationNumber: booking.reservation.confirmation_number,
        message: booking.checkoutError ?? 'Could not start payment. Your booking is on hold — try again below.',
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create this booking.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRetryCheckout() {
    if (!checkoutFailure) return;
    setSubmitting(true);
    setError(null);
    try {
      const email = isAuthenticated ? guest?.email : guestForm.email;
      const retried = await portalApi.retryStartCheckout({
        propertySlug,
        confirmationNumber: checkoutFailure.confirmationNumber,
        email,
        callbackUrl: `${window.location.origin}/portal/${propertySlug}/confirmation/${checkoutFailure.confirmationNumber}`,
      });
      if (retried.authorizationUrl) {
        window.location.assign(retried.authorizationUrl);
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
          <p>
            Your booking (confirmation <strong>{checkoutFailure.confirmationNumber}</strong>) is being held. You can retry payment now, or come back
            to it later using your confirmation number.
          </p>
          <div className={formStyles.actionsRow}>
            <Button onClick={handleRetryCheckout} loading={submitting}>
              Retry payment
            </Button>
            <Button variant="ghost" onClick={() => navigate(`/portal/${propertySlug}`)}>
              Back to start
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Review and pay</h1>

      {(error || missingDetails) && (
        <p role="alert" className={formStyles.errorBanner}>
          {error ?? 'This booking is missing required details — please search again.'}
        </p>
      )}

      <div className={styles.summary}>
        <p>
          <strong>{roomTypeName}</strong>
        </p>
        <p>
          {arrivalDate} → {departureDate}
        </p>
        <p>
          {adults} adult{adults === '1' ? '' : 's'}
          {Number(children) > 0 ? `, ${children} child${children === '1' ? '' : 'ren'}` : ''}
        </p>
        {rate && (
          <p>
            <Money amount={rate} currencyCode={currencyCode} /> / night
          </p>
        )}
      </div>

      <Card title={isAuthenticated ? 'Booking as' : 'Your details'}>
        <form className={formStyles.form} onSubmit={handleSubmit}>
          {isAuthenticated ? (
            <p>{guest?.email}</p>
          ) : (
            <>
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>First name</span>
                  <input
                    className={formStyles.input}
                    value={guestForm.first_name}
                    onChange={(event) => setGuestForm({ ...guestForm, first_name: event.target.value })}
                    required
                  />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Last name</span>
                  <input
                    className={formStyles.input}
                    value={guestForm.last_name}
                    onChange={(event) => setGuestForm({ ...guestForm, last_name: event.target.value })}
                    required
                  />
                </label>
              </div>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Email</span>
                <input
                  className={formStyles.input}
                  type="email"
                  value={guestForm.email}
                  onChange={(event) => setGuestForm({ ...guestForm, email: event.target.value })}
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Phone (optional)</span>
                <input
                  className={formStyles.input}
                  type="tel"
                  value={guestForm.phone}
                  onChange={(event) => setGuestForm({ ...guestForm, phone: event.target.value })}
                />
              </label>
            </>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={missingDetails}>
              Continue to payment
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
