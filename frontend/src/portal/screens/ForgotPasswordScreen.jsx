import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { portalApi, ApiError } from '../../shared/api/index.js';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/**
 * ForgotPasswordScreen — gap closure (flagged in CLAUDE.md's own Phase 4
 * section, built via feature-dev): guest password-reset. Standalone, no
 * `GuestAuthContext` — at this point no guest session exists to hold, the
 * same reasoning `AcceptInvitationScreen` (the staff app's own equivalent
 * "no session yet" screen) already establishes.
 *
 * Always shows the same anti-enumeration-safe confirmation regardless of
 * whether the address resolved to a real account (matching the backend's
 * own identical-response-shape guarantee) — the dev-only token, when
 * present, is an ADDITIONAL disclosure beneath that confirmation, not a
 * replacement for it, so this screen never leaks whether an account exists
 * even outside production.
 */
export function ForgotPasswordScreen() {
  const { propertySlug } = useOutletContext();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await portalApi.requestPasswordReset({ propertySlug, email });
      setDevToken(result?.dev_only_token ?? null);
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not request a password reset.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className={styles.page}>
        <Card title="Check your email">
          <p>If an account exists for that address, a reset link is on its way.</p>
          {devToken && (
            <p className={formStyles.disabledNotice}>
              Dev-only (never shown outside a non-production environment): reset token <code>{devToken}</code>
            </p>
          )}
          <Link className={formStyles.link} to={`/portal/${propertySlug}/login`}>
            Back to sign in
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Reset your password</h1>
      <Card>
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Email</span>
            <input
              className={formStyles.input}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting}>
              Send reset link
            </Button>
            <Link className={formStyles.link} to={`/portal/${propertySlug}/login`}>
              Back to sign in
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
