import { useState } from 'react';
import { Card, Button } from '../../../shared/components/index.js';
import { authApi, ApiError } from '../../../shared/api/index.js';
import styles from './StaffLoginScreen.module.css';
import formStyles from '../../setup/SetupForm.module.css';

/**
 * AcceptInvitationScreen — PLAN.md Phase 1 gap closure,
 * PRODUCT_REQUIREMENTS.md §3.16: "invitee sets their own password."
 *
 * Reached from an emailed invitation link's `?invite_token=` URL parameter
 * (`main.jsx` checks for it ahead of the normal login/app-shell flow, since
 * this app still has no router to give this its own path). Deliberately
 * does not auto-log-in on success — `src/auth/service.js`'s
 * `acceptInvitation` only creates the account; this screen's own success
 * state links back to the plain login screen instead, keeping this flow
 * from needing anything beyond `POST /auth/invitations/accept`.
 */
export function AcceptInvitationScreen({ token, isOffline = false }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [accepted, setAccepted] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await authApi.acceptInvitation({
        token,
        firstName: form.firstName,
        lastName: form.lastName,
        password: form.password,
      });
      setAccepted(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not accept this invitation.');
    } finally {
      setSubmitting(false);
    }
  }

  if (accepted) {
    return (
      <div className={styles.page}>
        <Card title="Account created">
          <p>Your account is ready. Go to the sign-in page and log in with your new password.</p>
          <Button onClick={() => window.location.assign(window.location.pathname)}>Go to sign in</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Card title="Set up your account">
        {isOffline && <p className={formStyles.disabledNotice}>You appear to be offline — try again once you&rsquo;re back online.</p>}
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>First name</span>
              <input
                className={formStyles.input}
                value={form.firstName}
                onChange={(event) => setForm({ ...form, firstName: event.target.value })}
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Last name</span>
              <input
                className={formStyles.input}
                value={form.lastName}
                onChange={(event) => setForm({ ...form, lastName: event.target.value })}
                required
              />
            </label>
          </div>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Password</span>
            <input
              className={formStyles.input}
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              required
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              Create account
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
