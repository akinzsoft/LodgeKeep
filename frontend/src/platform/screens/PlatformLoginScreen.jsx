import { useState } from 'react';
import { Button } from '../../shared/components/index.js';
import { usePlatformAuth } from '../auth/PlatformAuthContext.jsx';
import styles from './PlatformScreens.module.css';

/**
 * PlatformLoginScreen — PLAN.md Phase 5 (Platform Foundation). A plain,
 * utilitarian login form — this is an internal support tool, not a
 * tenant-facing branded surface (`StaffLoginScreen`'s split-panel branding
 * has no analog here, deliberately).
 */
export function PlatformLoginScreen() {
  const { status, error, login } = usePlatformAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function handleSubmit(event) {
    event.preventDefault();
    login(email, password);
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>LodgeKeep Platform</h1>
        <p className={styles.subtitle}>Internal support console — separate from any tenant&apos;s own staff login.</p>
        {error && (
          <p role="alert" className={styles.errorBanner}>
            {error}
          </p>
        )}
        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>Email</span>
            <input className={styles.input} type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Password</span>
            <input className={styles.input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <Button type="submit" loading={status === 'authenticating'}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
