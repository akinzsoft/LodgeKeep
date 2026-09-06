import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { useGuestAuth } from '../auth/GuestAuthContext.jsx';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/**
 * LoginScreen — PRODUCT_REQUIREMENTS.md §3.16's guest account sign-in.
 * `GuestAuthContext.login()` owns the request/status/error handling; this
 * screen only reads its `error` and navigates on success, the same split
 * `StaffLoginScreen` uses against `AuthContext`.
 */
export function LoginScreen() {
  const { propertySlug } = useOutletContext();
  const navigate = useNavigate();
  const { login, status, error } = useGuestAuth();
  const [form, setForm] = useState({ email: '', password: '' });

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      await login({ email: form.email, password: form.password });
      navigate(`/portal/${propertySlug}/account/bookings`);
    } catch {
      // GuestAuthContext already captured this in its own `error` state.
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Sign in</h1>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error.message}
        </p>
      )}

      <Card>
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Email</span>
            <input
              className={formStyles.input}
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          </label>
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
            <Button type="submit" loading={status === 'authenticating'}>
              Sign in
            </Button>
            <Link className={formStyles.link} to={`/portal/${propertySlug}/register`}>
              Create an account
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
