import { useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { portalApi, ApiError } from '../../shared/api/index.js';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/**
 * ResetPasswordScreen — gap closure (flagged in CLAUDE.md's own Phase 4
 * section, built via feature-dev): guest password-reset. Standalone, no
 * `GuestAuthContext`, same reasoning as `ForgotPasswordScreen`. Reached via
 * a real router path (`/portal/:propertySlug/reset-password?token=...`),
 * unlike the staff app's `?invite_token=`-ahead-of-routing workaround —
 * the portal has a real router to give this its own path.
 *
 * A single new-password field, no confirm field — matching
 * `AcceptInvitationScreen`'s own established convention for this class of
 * screen, not inventing a new one.
 */
export function ResetPasswordScreen() {
  const { propertySlug } = useOutletContext();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await portalApi.completePasswordReset({ token, newPassword });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reset your password.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className={styles.page}>
        <Card title="This link isn't valid">
          <p>This password reset link is missing or malformed. Request a new one from the sign-in page.</p>
          <Link className={formStyles.link} to={`/portal/${propertySlug}/forgot-password`}>
            Request a new reset link
          </Link>
        </Card>
      </div>
    );
  }

  if (done) {
    return (
      <div className={styles.page}>
        <Card title="Password reset">
          <p>Your password has been reset. You can now sign in with your new password.</p>
          <Link className={formStyles.link} to={`/portal/${propertySlug}/login`}>
            Sign in
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Choose a new password</h1>
      <Card>
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>New password</span>
            <input
              className={formStyles.input}
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting}>
              Reset password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
