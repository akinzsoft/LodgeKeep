import { useState } from 'react';
import { Button } from '../../../shared/components/index.js';
import { Footer } from '../../shell/Footer.jsx';
import { authApi, ApiError } from '../../../shared/api/index.js';
import { buildTenantLoginUrl } from './tenant-url.js';
import { slugify } from './slugify.js';
import lodgekeepIcon from '../../../assets/brand/lodgekeep-icon.png';
import styles from './StaffLoginScreen.module.css';

const EMPTY_FORM = {
  companyName: '',
  slug: '',
  timezone: '',
  baseCurrency: '',
  adminFirstName: '',
  adminLastName: '',
  adminEmail: '',
  adminPassword: '',
};

/**
 * SignupScreen — PLAN.md Phase 5 gap closure. `POST /api/v1/signup` has been
 * real since the self-service signup/lifecycle pass (PRODUCT_REQUIREMENTS.md
 * §3.22, "no engineer in the loop") — this is the browser form that was
 * missing for it, mounted at bare `/signup` in `main.jsx`'s top-level
 * pathname fork (public, no `AuthProvider`, no session of any kind — the
 * same "fourth tree" shape `PortalApp`/`PlatformApp`/`QrOrderApp` each
 * already have, just a single standalone screen rather than a whole
 * sub-app, since signup has no second screen to route between).
 *
 * User-reported: the first version (a bare `Card` on a plain page, reusing
 * `AcceptInvitationScreen`'s minimal one-off-token shape) wasn't "a standard
 * signup page." Rebuilt on `StaffLoginScreen`'s own branded split-panel —
 * the same visual language a prospective customer's very next screen (their
 * new tenant's own login page) already uses, rather than two differently-
 * dressed screens back to back. Two ordinary SaaS-signup conveniences this
 * pass adds that a bare form wouldn't have: the subdomain auto-fills from
 * the company name (`slugify.js`) until a person edits it directly, and
 * editing it shows a live preview of the real URL it resolves to.
 *
 * Deliberately does NOT auto-log the new admin in — this page is not on the
 * new tenant's own subdomain (tenant resolution is Host-header-based,
 * `src/auth/tenant-resolution.js`), so there is no safe way to *use* a
 * session minted for it from here even if one arrived in the response,
 * which it doesn't: the refresh token travels only as the same HttpOnly
 * cookie `/auth/login` uses (`shared/api/auth.js`'s own header has the full
 * story on that gap closure), and it's scoped to the new tenant's own
 * subdomain regardless. The success state instead builds the new tenant's
 * own login URL (`tenant-url.js`) and sends the browser there with a real
 * navigation — the same "created, now sign in separately" shape
 * `AcceptInvitationScreen`'s own header already established for an
 * identical account-creation-without-a-usable-session-here situation.
 */
export function SignupScreen({ isOffline = false }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [slugTouched, setSlugTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  function update(field) {
    return (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  }

  function updateCompanyName(event) {
    const companyName = event.target.value;
    setForm((current) => ({
      ...current,
      companyName,
      // Only while the person hasn't typed into the subdomain field
      // themselves — the moment they do, `handleSlugChange` marks it
      // touched and this suggestion stops overwriting their own edit.
      slug: slugTouched ? current.slug : slugify(companyName),
    }));
  }

  function handleSlugChange(event) {
    setSlugTouched(true);
    setForm((current) => ({ ...current, slug: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isOffline || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authApi.signup(form);
      setResult({ slug: form.slug, trialEndsAt: response.trialEndsAt });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create your organization.');
    } finally {
      setSubmitting(false);
    }
  }

  const slugPreviewUrl = form.slug ? buildTenantLoginUrl(form.slug) : null;

  if (result) {
    const loginUrl = buildTenantLoginUrl(result.slug);
    const trialEndsLabel = result.trialEndsAt ? new Date(result.trialEndsAt).toLocaleDateString() : null;
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
              <p className={styles.tenantLabel}>You&rsquo;re all set</p>
              <p className={styles.tagline}>Front desk, housekeeping, and cashiering — one system, every property.</p>
            </div>
          </div>

          <div className={styles.formPanel}>
            <div className={styles.formCard}>
              <h1 className={styles.title}>Your organization is ready</h1>
              <p className={styles.subtitle}>
                {trialEndsLabel
                  ? `Your free trial runs until ${trialEndsLabel}. Sign in to finish setting up your first property.`
                  : 'Sign in to finish setting up your first property.'}
              </p>
              {loginUrl && (
                <Button className={styles.submit} onClick={() => window.location.assign(loginUrl)}>
                  Go to sign in
                </Button>
              )}
            </div>
          </div>
        </div>
        <Footer />
      </div>
    );
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
            <p className={styles.tenantLabel}>Start your free trial</p>
            <p className={styles.tagline}>Front desk, housekeeping, and cashiering — one system, every property. No credit card required.</p>
          </div>
        </div>

        <div className={styles.formPanel}>
          <div className={styles.formCard}>
            {isOffline && (
              <p className={styles.offlineBanner} role="status">
                You&rsquo;re offline. Reconnect to create your organization.
              </p>
            )}

            <h1 className={styles.title}>Create your organization</h1>
            <p className={styles.subtitle}>Set up your property in a few minutes — no engineer needed.</p>

            {error && (
              <p role="alert" className={styles.errorBanner}>
                {error}
              </p>
            )}

            <form className={styles.form} onSubmit={handleSubmit}>
              <label className={styles.field}>
                <span className={styles.label}>Company name</span>
                <input
                  className={styles.input}
                  value={form.companyName}
                  onChange={updateCompanyName}
                  placeholder="Riverside Hotels"
                  required
                />
              </label>

              <label className={styles.field}>
                <span className={styles.label}>Subdomain</span>
                <input
                  className={styles.input}
                  value={form.slug}
                  onChange={handleSlugChange}
                  placeholder="riverside-hotels"
                  required
                />
              </label>
              {/* Deliberately a sibling of, not nested inside, the <label>
                  above — text nested inside an implicit wrapper label gets
                  folded into that label's own computed accessible name
                  (confirmed live: it broke an exact `getByLabelText('Password')`
                  match on this field's own twin below before this was fixed),
                  which would make "Subdomain" alone no longer exactly match
                  once this hint is showing. */}
              {slugPreviewUrl && <p className={styles.hint}>Your team will sign in at {slugPreviewUrl}</p>}

              <div className={styles.row}>
                <label className={styles.field}>
                  <span className={styles.label}>Timezone</span>
                  <input
                    className={styles.input}
                    value={form.timezone}
                    onChange={update('timezone')}
                    placeholder="Africa/Lagos"
                    required
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Base currency</span>
                  <input
                    className={styles.input}
                    value={form.baseCurrency}
                    onChange={(event) => setForm((current) => ({ ...current, baseCurrency: event.target.value.toUpperCase() }))}
                    placeholder="NGN"
                    maxLength={3}
                    required
                  />
                </label>
              </div>

              <div className={styles.row}>
                <label className={styles.field}>
                  <span className={styles.label}>Your first name</span>
                  <input
                    className={styles.input}
                    value={form.adminFirstName}
                    onChange={update('adminFirstName')}
                    autoComplete="given-name"
                    required
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Your last name</span>
                  <input
                    className={styles.input}
                    value={form.adminLastName}
                    onChange={update('adminLastName')}
                    autoComplete="family-name"
                    required
                  />
                </label>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>Your email</span>
                <input
                  className={styles.input}
                  type="email"
                  autoComplete="username"
                  value={form.adminEmail}
                  onChange={update('adminEmail')}
                  required
                />
              </label>

              <label className={styles.field}>
                <span className={styles.label}>Password</span>
                <div className={styles.passwordRow}>
                  <input
                    className={styles.input}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={form.adminPassword}
                    onChange={update('adminPassword')}
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
              {/* See the identical note on the Subdomain field above. */}
              <p className={styles.hint}>At least 12 characters.</p>

              <Button type="submit" loading={submitting} disabled={isOffline} className={styles.submit}>
                Create organization
              </Button>
            </form>

            <div className={styles.links}>
              <a className={styles.linkButton} href="/">
                Already have an account? Sign in
              </a>
            </div>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
