import { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { Button } from '../../../shared/components/index.js';
import { Footer } from '../../shell/Footer.jsx';
import styles from './MfaChallengeScreen.module.css';

/**
 * MfaChallengeScreen — PRODUCT_REQUIREMENTS.md §3.16: "MFA challenge as a
 * second step for roles that require it."
 *
 * Gap closure (user-reported, live-tested): "the verification code shld be
 * send to the account email to login not a static code." `POST
 * /auth/mfa/verify` now checks a real, emailed 6-digit code
 * (`src/auth/mfa.js`/`service.js`'s `verifyStaffMfa`) — a wrong, expired,
 * already-used, or attempts-exhausted code gets a real
 * `AUTH_MFA_CODE_INVALID` 401, not the old `AUTH_MFA_NOT_IMPLEMENTED` 501
 * every submission used to get. Real TOTP/authenticator-app enrollment is
 * still not built — this closes the "no verification exists at all" gap
 * with a real emailed code, not a QR-code flow.
 *
 * Still no frontend-side environment check of its own — the backend's
 * actual response is what drives what a person sees here, per this
 * codebase's own "UI-level ... is convenience only, the API check is the
 * real one" rule. `mfaDevOnlyCode` (outside production only) is shown as an
 * additional disclosure beneath the form, the same shape
 * `ForgotPasswordScreen` already uses for its own dev-only token — never a
 * substitute for actually typing the code in, so a real client-side
 * submission flow is always exercised, dev environment included.
 */
export function MfaChallengeScreen() {
  const { status, error, cancelMfaChallenge, verifyMfa, mfaDevOnlyCode } = useAuth();
  const [code, setCode] = useState('');
  const isSubmitting = status === 'authenticating';

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      await verifyMfa(code);
    } catch {
      // AuthContext already recorded `error` for this render — nothing further to do.
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.center}>
        <div className={styles.card}>
          <h1 className={styles.title}>Verification required</h1>
          <p className={styles.body}>
            This account requires multi-factor authentication. We&rsquo;ve emailed you a verification code — enter it below to continue.
          </p>

          {error && (
            <p role="alert" className={styles.errorBanner}>
              {error.message}
            </p>
          )}

          {mfaDevOnlyCode && (
            <p className={styles.devNote}>
              Dev-only (never shown outside a non-production environment): verification code <code>{mfaDevOnlyCode}</code>
            </p>
          )}

          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.field}>
              <span className={styles.label}>Verification code</span>
              <input
                className={styles.input}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </label>
            <Button type="submit" loading={isSubmitting} disabled={isSubmitting || code.length === 0}>
              Verify
            </Button>
          </form>

          <Button variant="secondary" onClick={cancelMfaChallenge} className={styles.backButton}>
            Back to sign in
          </Button>
        </div>
      </div>

      <Footer />
    </div>
  );
}
