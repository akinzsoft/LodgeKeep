import { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { Button } from '../../../shared/components/index.js';
import { Footer } from '../../shell/Footer.jsx';
import { deriveTenantLabelFromHost } from './tenant-label.js';
import lodgekeepIcon from '../../../assets/brand/lodgekeep-icon.png';
import styles from './StaffLoginScreen.module.css';

/**
 * StaffLoginScreen — the real PRODUCT_REQUIREMENTS.md §3.16 "Staff login"
 * surface, replacing the throwaway `DevLoginForm`. "The first impression of
 * the product and the most security-sensitive UI in it."
 *
 * Implements, from that section: tenant-branded panel (see `tenant-label.js`
 * for what "branded" honestly means today), email/password, "remember this
 * device", forgot-password (inline request → sent confirmation, not a
 * separate route — there is no router in this app yet), a "find my company"
 * link, generic invalid-credentials messaging (the backend already collapses
 * "wrong password" and "no such account" into one message — this screen
 * never re-splits it), and the lockout state's own message. All six
 * DESIGN_SYSTEM.md §2 states apply: loading (submit button), error (banner),
 * offline (submit disabled, banner shown), success (handled by the caller
 * switching `status` to 'authenticated' — no toast; a redirect *is* the
 * confirmation here, per §2's "the toast is the success" reasoning applied
 * to a full navigation instead).
 *
 * NOT implemented, deliberately, rather than faked:
 *   - Real tenant branding (logo/colour) — no endpoint returns it pre-login.
 *   - "Find my company" as a working flow — no endpoint resolves a tenant
 *     from an email address across tenants (and probably shouldn't without
 *     real thought about the enumeration risk that implies). This link
 *     opens an honest "contact support" panel instead of pretending to work.
 *   - The terminal lock screen — a distinct, stateful feature (inactivity
 *     timeout, PIN re-entry, "switch user") that deserves its own pass
 *     rather than being squeezed into this one.
 *   - "Remember this device" changing anything server-side — the backend's
 *     refresh-token TTL (`JWT_REFRESH_TTL`) is fixed, not differentiated per
 *     device. The checkbox is kept (the spec names it as a required field)
 *     but is presentational only; wiring it needs a backend change.
 *
 * @param {boolean} [isOffline]
 */
export function StaffLoginScreen({ isOffline = false }) {
  const { status, error, login, requestPasswordReset } = useAuth();
  const [view, setView] = useState('signin'); // 'signin' | 'forgot-request' | 'forgot-sent' | 'find-company'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetToken, setResetToken] = useState(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  const tenantLabel = deriveTenantLabelFromHost();
  const isSubmitting = status === 'authenticating';
  const isLocked = error?.code === 'LOCKED_ACCOUNT';

  async function handleSubmit(event) {
    event.preventDefault();
    if (isOffline || isSubmitting) return;
    try {
      await login({ email, password });
    } catch {
      // AuthContext already recorded `error` for this render — nothing
      // further to do here.
    }
  }

  async function handleResetSubmit(event) {
    event.preventDefault();
    setResetSubmitting(true);
    try {
      const result = await requestPasswordReset({ email: resetEmail });
      setResetToken(result.dev_only_token ?? null);
      setView('forgot-sent');
    } finally {
      setResetSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.mainRow}>
        <div className={styles.brandPanel}>
          <div className={styles.brandTop}>
            <div className={styles.logoMark}>
              <img src={lodgekeepIcon} alt="" className={styles.logoMarkIcon} />
            </div>
            <p className={styles.wordmark}>LodgeKeep</p>
          </div>

          <div className={styles.brandContent}>
            {tenantLabel && <p className={styles.tenantLabel}>{tenantLabel}</p>}
            <p className={styles.tagline}>Front desk, housekeeping, and cashiering — one system, every property.</p>
          </div>
        </div>

        <div className={styles.formPanel}>
          <div className={styles.formCard}>
            {isOffline && (
              <p className={styles.offlineBanner} role="status">
                You&rsquo;re offline. Reconnect to sign in.
              </p>
            )}

            {view === 'signin' && (
              <>
                <h1 className={styles.title}>Sign in</h1>
                <p className={styles.subtitle}>
                  {tenantLabel ? `Sign in to ${tenantLabel}` : 'Sign in to your property'}
                </p>

                {error && !isLocked && (
                  <p className={styles.errorBanner} role="alert">
                    {error.message}
                  </p>
                )}
                {isLocked && (
                  <p className={styles.errorBanner} role="alert">
                    Too many attempts. Try again later, or use &ldquo;Forgot password&rdquo; below to regain access sooner.
                  </p>
                )}

                <form className={styles.form} onSubmit={handleSubmit}>
                  <label className={styles.field}>
                    <span className={styles.label}>Email</span>
                    <input
                      className={styles.input}
                      type="email"
                      autoComplete="username"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                  </label>

                  <label className={styles.field}>
                    <span className={styles.label}>Password</span>
                    <div className={styles.passwordRow}>
                      <input
                        className={styles.input}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setShowPassword((show) => !show)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </Button>
                    </div>
                  </label>

                  <label className={styles.checkboxRow}>
                    <span className={styles.checkboxInputRow}>
                      <input type="checkbox" className={styles.checkbox} defaultChecked />
                    </span>
                    <span>
                      <span className={styles.checkboxLabel}>Remember this device</span>
                      <span className={styles.checkboxCaption}>Stay signed in longer on this terminal</span>
                    </span>
                  </label>

                  <Button type="submit" loading={isSubmitting} disabled={isOffline} className={styles.submit}>
                    Sign in
                  </Button>
                </form>

                <div className={styles.links}>
                  <button type="button" className={styles.linkButton} onClick={() => setView('forgot-request')}>
                    Forgot password?
                  </button>
                  <button type="button" className={styles.linkButton} onClick={() => setView('find-company')}>
                    Can&rsquo;t find your company?
                  </button>
                </div>
              </>
            )}

            {view === 'forgot-request' && (
              <>
                <h1 className={styles.title}>Reset your password</h1>
                <p className={styles.subtitle}>We&rsquo;ll email a single-use reset link to this address.</p>
                <form className={styles.form} onSubmit={handleResetSubmit}>
                  <label className={styles.field}>
                    <span className={styles.label}>Email</span>
                    <input
                      className={styles.input}
                      type="email"
                      autoComplete="username"
                      value={resetEmail}
                      onChange={(event) => setResetEmail(event.target.value)}
                      required
                    />
                  </label>
                  <Button type="submit" loading={resetSubmitting} className={styles.submit}>
                    Send reset link
                  </Button>
                </form>
                <div className={styles.links}>
                  <button type="button" className={styles.linkButton} onClick={() => setView('signin')}>
                    Back to sign in
                  </button>
                </div>
              </>
            )}

            {view === 'forgot-sent' && (
              <>
                <h1 className={styles.title}>Check your email</h1>
                <p className={styles.subtitle}>
                  If an account exists for that address, a reset link is on its way.
                </p>
                {resetToken && (
                  <p className={styles.devNote}>
                    Dev-only (never shown outside a non-production environment): reset token <code>{resetToken}</code>
                  </p>
                )}
                <div className={styles.links}>
                  <button type="button" className={styles.linkButton} onClick={() => setView('signin')}>
                    Back to sign in
                  </button>
                </div>
              </>
            )}

            {view === 'find-company' && (
              <>
                <h1 className={styles.title}>Find your company</h1>
                <p className={styles.subtitle}>
                  Each property signs in from its own address, such as <code>yourhotel.lodgekeep.app</code>. If you&rsquo;ve
                  forgotten yours, ask your manager or administrator — automatic company lookup by email isn&rsquo;t available
                  yet.
                </p>
                <div className={styles.links}>
                  <button type="button" className={styles.linkButton} onClick={() => setView('signin')}>
                    Back to sign in
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
}
