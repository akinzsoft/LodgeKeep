import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { qrOrderingApi, ApiError } from '../../shared/api/index.js';
import styles from '../QrOrderScreen.module.css';
import formStyles from '../QrOrderForm.module.css';

/**
 * RoomChargeConfirmScreen — the emailed-OTP second factor
 * (`qr-ordering/service.js`'s own header: "a one-time code emailed to the
 * room's CURRENT IN-HOUSE RESERVATION'S OWN registered email, never a
 * guest-typed contact"). Three real steps against three real endpoints:
 * confirm-name (a masked "is this you?" check) -> request-otp (emails the
 * real code) -> verify (settles the order as a real folio charge).
 *
 * `devOnlyCode` (outside production only) is shown as an ADDITIONAL
 * disclosure beneath the real code-entry form, the same shape
 * `MfaChallengeScreen.jsx`/`ForgotPasswordScreen.jsx` already establish —
 * never a substitute for actually typing the code in.
 */
export function RoomChargeConfirmScreen() {
  const { token } = useOutletContext();
  const { id } = useParams();
  const navigate = useNavigate();

  const [step, setStep] = useState('loading'); // loading -> confirm -> otp -> error
  const [maskedName, setMaskedName] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [sendingOtp, setSendingOtp] = useState(false);
  const [devOnlyCode, setDevOnlyCode] = useState(null);

  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    qrOrderingApi
      .confirmRoomChargeName({ token, id })
      .then((result) => {
        if (cancelled) return;
        setMaskedName(result.maskedName);
        setStep('confirm');
      })
      .catch((caught) => {
        if (cancelled) return;
        setLoadError(caught instanceof ApiError ? caught.message : 'Could not confirm the in-house guest for this room.');
        setStep('error');
      });
    return () => {
      cancelled = true;
    };
  }, [token, id]);

  async function handleSendCode() {
    setSendingOtp(true);
    setLoadError(null);
    try {
      const result = await qrOrderingApi.requestRoomChargeOtp({ token, id });
      setDevOnlyCode(result.devOnlyCode ?? null);
      setStep('otp');
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not send a verification code.');
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleVerify(event) {
    event.preventDefault();
    setVerifying(true);
    setVerifyError(null);
    try {
      await qrOrderingApi.verifyRoomChargeOtp({ token, id, code });
      navigate('../status', { relative: 'path' });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'CONFLICT_GUEST_ORDER_ALREADY_PAID') {
        navigate('../status', { relative: 'path' });
        return;
      }
      setVerifyError(caught instanceof ApiError ? caught.message : 'Could not verify this code.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Charge to my room</h1>

      {step === 'loading' && <Card state="loading" />}

      {step === 'error' && (
        <Card>
          <p role="alert" className={formStyles.errorBanner}>
            {loadError}
          </p>
        </Card>
      )}

      {step === 'confirm' && (
        <Card>
          <div className={styles.maskedNameCard}>
            <p>
              Is this you: <strong>{maskedName}</strong>?
            </p>
            <p className={formStyles.hint}>We&rsquo;ll email a one-time verification code to the address on this room&rsquo;s reservation.</p>
            {loadError && (
              <p role="alert" className={formStyles.errorBanner}>
                {loadError}
              </p>
            )}
            <div className={formStyles.actionsRow}>
              <Button onClick={handleSendCode} loading={sendingOtp}>
                Yes, send the code
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 'otp' && (
        <Card>
          <p>We&rsquo;ve emailed a 6-digit code to the room&rsquo;s reservation contact. Enter it below to complete your order.</p>

          {devOnlyCode && (
            <p className={styles.devNote}>
              Dev-only (never shown outside a non-production environment): verification code <code>{devOnlyCode}</code>
            </p>
          )}

          {verifyError && (
            <p role="alert" className={formStyles.errorBanner}>
              {verifyError}
            </p>
          )}

          <form className={formStyles.form} onSubmit={handleVerify}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Verification code</span>
              <input
                className={formStyles.input}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={verifying} disabled={code.length === 0}>
                Confirm
              </Button>
              <Button type="button" variant="ghost" onClick={handleSendCode} disabled={sendingOtp}>
                Send a new code
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
