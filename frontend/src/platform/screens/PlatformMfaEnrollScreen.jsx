import { useState } from 'react';
import { Button } from '../../shared/components/index.js';
import { usePlatformAuth } from '../auth/PlatformAuthContext.jsx';
import styles from './PlatformScreens.module.css';

/**
 * PlatformMfaEnrollScreen — PLAN.md Phase 5 (Platform Foundation). Shown
 * only the FIRST time a platform_users account logs in (no `mfa_secret`
 * enrolled yet). Real TOTP enrollment — no dev-only disclosure of any
 * kind, in any environment, unlike staff's own MFA screen: TOTP has no
 * equivalent "dev bypass" concept, and this is exactly the population
 * SECURITY.md §1.1 calls out for "no long-lived tokens for privileged
 * roles."
 */
export function PlatformMfaEnrollScreen() {
  const { enrollment, error, confirmEnrollment, cancelChallenge } = usePlatformAuth();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    await confirmEnrollment(code);
    setSubmitting(false);
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Set up your authenticator</h1>
        <p className={styles.subtitle}>Scan this code with an authenticator app (Google Authenticator, 1Password, Authy, ...), then enter the 6-digit code it shows.</p>
        {error && (
          <p role="alert" className={styles.errorBanner}>
            {error}
          </p>
        )}
        {enrollment?.qrCodeDataUrl && <img className={styles.qrCode} src={enrollment.qrCodeDataUrl} alt="Scan with your authenticator app" />}
        <p className={styles.hint}>
          Can&apos;t scan? Enter this key manually: <span className={styles.manualKey}>{enrollment?.manualEntryKey}</span>
        </p>
        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>6-digit code</span>
            <input
              className={styles.input}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoFocus
            />
          </label>
          <div className={styles.actionsRow}>
            <Button type="submit" loading={submitting}>
              Confirm and continue
            </Button>
            <Button type="button" variant="ghost" onClick={cancelChallenge}>
              Back to sign in
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
