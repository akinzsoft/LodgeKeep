import { useState } from 'react';
import { Button } from '../../shared/components/index.js';
import { usePlatformAuth } from '../auth/PlatformAuthContext.jsx';
import styles from './PlatformScreens.module.css';

/** PlatformMfaChallengeScreen — an already-enrolled account's ordinary login. Plain code entry, no dev-only disclosure (see PlatformMfaEnrollScreen's own header). */
export function PlatformMfaChallengeScreen() {
  const { error, verifyMfa, cancelChallenge } = usePlatformAuth();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    await verifyMfa(code);
    setSubmitting(false);
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Enter your authenticator code</h1>
        {error && (
          <p role="alert" className={styles.errorBanner}>
            {error}
          </p>
        )}
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
              Verify
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
