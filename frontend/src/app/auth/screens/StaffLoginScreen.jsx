import { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { Button } from '../../../shared/components/index.js';
import { ApiError } from '../../../shared/api/index.js';
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
 * device", forgot-password (inline request → enter code + new password, not
 * a separate route — there is no router in this app yet), a "find my
 * company" link, generic invalid-credentials messaging (the backend already
 * collapses "wrong password" and "no such account" into one message — this
 * screen never re-splits it), and the lockout state's own message. All six
 * DESIGN_SYSTEM.md §2 states apply: loading (submit button), error (banner),
 * offline (submit disabled, banner shown), success (handled by the caller
 * switching `status` to 'authenticated' — no toast; a redirect *is* the
 * confirmation here, per §2's "the toast is the success" reasoning applied
 * to a full navigation instead).
 *
 * Gap closure (user-reported): the forgot-password flow now emails a
 * 6-digit code the person types into the app, rather than a reset link — it
 * reuses `MfaChallengeScreen`'s own numeric-code-entry shape (a single
 * digit-code field, a dev-only disclosure outside production) plus a new
 * password field, since there is no link here to click through. Confirmed
 * with the user: the old link-based flow is removed entirely, not kept
 * alongside this one.
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
  const { status, error, login, requestPasswordResetCode, completePasswordResetWithCode } = useAuth();
  const [view, setView] = useState('signin'); // 'signin' | 'forgot-request' | 'forgot-verify' | 'find-company'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetToken, setResetToken] = useState(null);
  const [resetDevOnlyCode, setResetDevOnlyCode] = useState(null);
  const [resetCode, setResetCode] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetRequestError, setResetRequestError] = useState(null);
  const [resetCompleteError, setResetCompleteError] = useState(null);
  const [resetDone, setResetDone] = useState(false);

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

  /** Returns every reset-flow field to its initial value — used both by "Back to sign in" and right before a fresh "Forgot password?" request, so a later attempt never resurfaces a stale code/token/error from an abandoned one. */
  function resetToSignin() {
    setView('signin');
    setResetEmail('');
    setResetToken(null);
    setResetDevOnlyCode(null);
    setResetCode('');
    setResetNewPassword('');
    setResetRequestError(null);
    setResetCompleteError(null);
    setResetDone(false);
  }

  /**
   * User-reported: a 429 (or any other real backend rejection — e.g. an
   * unresolvable property, a transient failure) left this button appearing
   * dead — the request's rejection was never caught, so nothing set an
   * error state and nothing rendered one. Fixed the same way
   * `handleResetCompleteSubmit` already handles its own failure: catch,
   * surface the real backend message, never swallow it silently.
   */
  async function handleResetRequestSubmit(event) {
    event.preventDefault();
    if (isOffline || resetSubmitting) return;
    setResetSubmitting(true);
    setResetRequestError(null);
    try {
      const result = await requestPasswordResetCode({ email: resetEmail });
      setResetToken(result.reset_token);
      setResetDevOnlyCode(result.dev_only_code ?? null);
      setView('forgot-verify');
    } catch (caught) {
      setResetRequestError(caught instanceof ApiError ? caught.message : 'Could not send a reset code.');
    } finally {
      setResetSubmitting(false);
    }
  }

  async function handleResetCompleteSubmit(event) {
    event.preventDefault();
    if (isOffline || resetSubmitting) return;
    setResetSubmitting(true);
    setResetCompleteError(null);
    try {
      await completePasswordResetWithCode({ resetToken, code: resetCode, newPassword: resetNewPassword });
      setResetDone(true);
    } catch (caught) {
      setResetCompleteError(caught instanceof ApiError ? caught.message : 'Could not reset your password.');
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
                  <button type="button" className={styles.linkButton} onClick={() => { resetToSignin(); setView('forgot-request'); }}>
                    Forgot password?
                  </button>
                  <button type="button" className={styles.linkButton} onClick={() => setView('find-company')}>
                    Can&rsquo;t find your company?
                  </button>
                  <a className={styles.linkButton} href="/signup">
                    Create an account
                  </a>
                </div>
              </>
            )}

            {view === 'forgot-request' && (
              <>
                <h1 className={styles.title}>Reset your password</h1>
                <p className={styles.subtitle}>We&rsquo;ll email a 6-digit code to this address.</p>
                {resetRequestError && (
                  <p className={styles.errorBanner} role="alert">
                    {resetRequestError}
                  </p>
                )}
                <form className={styles.form} onSubmit={handleResetRequestSubmit}>
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
                  {isOffline && (
                    <p className={styles.errorBanner} role="alert">
                      You&rsquo;re offline — requesting a reset code is disabled until the connection returns.
                    </p>
                  )}
                  <Button type="submit" loading={resetSubmitting} disabled={isOffline} className={styles.submit}>
                    Send reset code
                  </Button>
                </form>
                <div className={styles.links}>
                  <button type="button" className={styles.linkButton} onClick={resetToSignin}>
                    Back to sign in
                  </button>
                </div>
              </>
            )}

            {view === 'forgot-verify' && !resetDone && (
              <>
                <h1 className={styles.title}>Enter your reset code</h1>
                <p className={styles.subtitle}>
                  We&rsquo;ve emailed a 6-digit code to {resetEmail || 'that address'}.
                </p>
                {resetCompleteError && (
                  <p className={styles.errorBanner} role="alert">
                    {resetCompleteError}
                  </p>
                )}
                {resetDevOnlyCode && (
                  <p className={styles.devNote}>
                    Dev-only (never shown outside a non-production environment): reset code <code>{resetDevOnlyCode}</code>
                  </p>
                )}
                <form className={styles.form} onSubmit={handleResetCompleteSubmit}>
                  <label className={styles.field}>
                    <span className={styles.label}>Reset code</span>
                    <input
                      className={styles.input}
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={resetCode}
                      onChange={(event) => setResetCode(event.target.value)}
                      required
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>New password</span>
                    <input
                      className={styles.input}
                      type="password"
                      autoComplete="new-password"
                      value={resetNewPassword}
                      onChange={(event) => setResetNewPassword(event.target.value)}
                      required
                    />
                  </label>
                  {isOffline && (
                    <p className={styles.errorBanner} role="alert">
                      You&rsquo;re offline — resetting your password is disabled until the connection returns.
                    </p>
                  )}
                  <Button
                    type="submit"
                    loading={resetSubmitting}
                    disabled={isOffline || resetSubmitting || resetCode.length === 0}
                    className={styles.submit}
                  >
                    Reset password
                  </Button>
                </form>
                <div className={styles.links}>
                  <button type="button" className={styles.linkButton} onClick={resetToSignin}>
                    Back to sign in
                  </button>
                </div>
              </>
            )}

            {view === 'forgot-verify' && resetDone && (
              <>
                <h1 className={styles.title}>Password reset</h1>
                <p className={styles.subtitle}>Your password has been reset. Sign in with your new password.</p>
                <div className={styles.links}>
                  <button type="button" className={styles.linkButton} onClick={resetToSignin}>
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
