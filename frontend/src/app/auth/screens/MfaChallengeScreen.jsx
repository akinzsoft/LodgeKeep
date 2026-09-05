import { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { Button } from '../../../shared/components/index.js';
import { Footer } from '../../shell/Footer.jsx';
import styles from './MfaChallengeScreen.module.css';

/**
 * MfaChallengeScreen — PRODUCT_REQUIREMENTS.md §3.16: "MFA challenge as a
 * second step for roles that require it." Real TOTP verification is still
 * not built (`src/auth/errors.js`'s `MfaNotImplementedError` header) — the
 * one code `POST /auth/mfa/verify` can ever accept today is
 * `src/auth/mfa.js`'s dev-only bypass value, never valid outside a
 * non-production backend.
 *
 * This screen always renders a real code-entry form and submits it for
 * real, with no frontend-side environment check of its own — the backend's
 * actual response (success outside production, or the same honest 501
 * everywhere else) is what should drive what a person sees here, per this
 * codebase's own "UI-level ... is convenience only, the API check is the
 * real one" rule. A wrong code, an expired challenge, or any submission
 * against a production backend surfaces that 501 as the same plain error
 * message DESIGN_SYSTEM.md §2 requires everywhere else, not a raw
 * exception string.
 */
export function MfaChallengeScreen() {
  const { status, error, logout, verifyMfa } = useAuth();
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
            This account requires multi-factor authentication. Enter your verification code to continue.
          </p>

          {error && (
            <p role="alert" className={styles.errorBanner}>
              {error.message}
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

          <Button variant="secondary" onClick={logout} className={styles.backButton}>
            Back to sign in
          </Button>
        </div>
      </div>

      <Footer />
    </div>
  );
}
