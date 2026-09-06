import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { useGuestAuth } from '../auth/GuestAuthContext.jsx';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

const EMPTY_FORM = { first_name: '', last_name: '', email: '', password: '', phone: '' };

/**
 * RegisterScreen — PRODUCT_REQUIREMENTS.md §3.16's guest account creation.
 * Mirrors `LoginScreen`'s split against `GuestAuthContext`; `register()`
 * signs the caller in immediately on success (`src/auth/service.js`'s own
 * `guestRegister` header explains why), so this screen navigates the same
 * place `LoginScreen` does rather than bouncing back to a sign-in form.
 */
export function RegisterScreen() {
  const { propertySlug } = useOutletContext();
  const navigate = useNavigate();
  const { register, status, error } = useGuestAuth();
  const [form, setForm] = useState(EMPTY_FORM);

  function setField(field) {
    return (event) => setForm({ ...form, [field]: event.target.value });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      await register({
        firstName: form.first_name,
        lastName: form.last_name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
      });
      navigate(`/portal/${propertySlug}/account/bookings`);
    } catch {
      // GuestAuthContext already captured this in its own `error` state.
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Create an account</h1>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error.message}
        </p>
      )}

      <Card>
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>First name</span>
              <input className={formStyles.input} value={form.first_name} onChange={setField('first_name')} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Last name</span>
              <input className={formStyles.input} value={form.last_name} onChange={setField('last_name')} required />
            </label>
          </div>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Email</span>
            <input className={formStyles.input} type="email" value={form.email} onChange={setField('email')} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Phone (optional)</span>
            <input className={formStyles.input} type="tel" value={form.phone} onChange={setField('phone')} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Password</span>
            <input className={formStyles.input} type="password" value={form.password} onChange={setField('password')} required />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={status === 'authenticating'}>
              Create account
            </Button>
            <Link className={formStyles.link} to={`/portal/${propertySlug}/login`}>
              Already have an account? Sign in
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
