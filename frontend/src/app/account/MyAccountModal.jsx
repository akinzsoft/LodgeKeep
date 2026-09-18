import { useEffect, useId, useState } from 'react';
import { Skeleton, Button } from '../../shared/components/index.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { ApiError } from '../../shared/api/index.js';
import styles from './MyAccountModal.module.css';

/**
 * MyAccountModal — self-service "My Profile" screen (user-requested): a
 * logged-in staff member previously had no way to view/update their own
 * name/phone or change their own password; the top-right user menu only
 * offered "Log out."
 *
 * Rendered as a modal (overlay + dialog, mirroring `ConfirmDialog`'s own
 * CSS shape, not its component — this is a rich form, not a title/
 * consequence/reason confirm) as a direct child of `<AppShell>`,
 * deliberately NOT registered in `nav-config.js`/`DEFAULT_NAV_GROUPS`:
 * `isNavItemAllowed` returns `false` for any unregistered key, and
 * `main.jsx`'s own `screenKey` fallback would bounce an unregistered key
 * straight back to `'home'`. An independent boolean flag in `main.jsx`
 * (toggled by the new TopBar "My Profile" menu item) keeps the sidebar/
 * business-date/property-switcher context intact underneath, which a
 * full-screen replacement would throw away for no reason — a personal-
 * account action shouldn't cost you your place in the app.
 *
 * Email is deliberately READ-ONLY (confirmed with the user): it's also
 * the login identifier, unique per tenant, and this codebase has no
 * email-verification infrastructure anywhere to safely back a self-service
 * change. Two independent sections/forms: profile fields, and change
 * password — a password change is NOT `ConfirmDialog`-gated (this isn't a
 * void/refund/cancel-shaped irreversible action; a plain submit matches
 * the existing forgot-password-completion screen's own precedent).
 *
 * @param {boolean} [isOffline]
 * @param {() => void} onClose
 */
export function MyAccountModal({ isOffline = false, onClose }) {
  const { getMyProfile, updateProfile, changeMyPassword } = useAuth();
  const titleId = useId();

  const [profile, setProfile] = useState(undefined); // undefined = loading, null = load failed
  const [profileForm, setProfileForm] = useState({ firstName: '', lastName: '', phone: '' });
  const [profileError, setProfileError] = useState(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmNewPassword: '' });
  const [passwordError, setPasswordError] = useState(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordResult, setPasswordResult] = useState(null);

  async function loadProfile() {
    setProfile(undefined);
    setProfileError(null);
    try {
      const data = await getMyProfile();
      setProfile(data);
      setProfileForm({ firstName: data.firstName, lastName: data.lastName, phone: data.phone ?? '' });
    } catch (caught) {
      setProfile(null);
      setProfileError(caught instanceof ApiError ? caught.message : 'Could not load your profile.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount, matching EmailSettingsTab.jsx's own established pattern
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch-on-mount only, `getMyProfile` is a stable context method
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function handleProfileSubmit(event) {
    event.preventDefault();
    if (isOffline || profileSaving) return;
    setProfileSaving(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      const result = await updateProfile({
        firstName: profileForm.firstName,
        lastName: profileForm.lastName,
        phone: profileForm.phone.trim() === '' ? null : profileForm.phone,
      });
      setProfile(result);
      setProfileForm({ firstName: result.firstName, lastName: result.lastName, phone: result.phone ?? '' });
      setProfileSaved(true);
    } catch (caught) {
      setProfileError(caught instanceof ApiError ? caught.message : 'Could not save your profile.');
    } finally {
      setProfileSaving(false);
    }
  }

  const confirmMismatch =
    passwordForm.newPassword.length > 0 &&
    passwordForm.confirmNewPassword.length > 0 &&
    passwordForm.newPassword !== passwordForm.confirmNewPassword;

  async function handlePasswordSubmit(event) {
    event.preventDefault();
    if (isOffline || passwordSubmitting) return;
    if (passwordForm.newPassword !== passwordForm.confirmNewPassword) return; // client-side only — never sent to the backend
    setPasswordSubmitting(true);
    setPasswordError(null);
    setPasswordResult(null);
    try {
      const result = await changeMyPassword({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      setPasswordForm({ currentPassword: '', newPassword: '', confirmNewPassword: '' });
      setPasswordResult(result.otherSessionsRevoked);
    } catch (caught) {
      setPasswordError(caught instanceof ApiError ? caught.message : 'Could not change your password.');
    } finally {
      setPasswordSubmitting(false);
    }
  }

  function passwordSuccessMessage(otherSessionsRevoked) {
    const base = "Password changed. This device stays signed in — every other device or browser has been signed out.";
    if (!otherSessionsRevoked) return 'Password changed.'; // 0 — nothing else to sign out of
    return `${base} (${otherSessionsRevoked} other session${otherSessionsRevoked === 1 ? '' : 's'})`;
  }

  return (
    <div className={styles.overlay} role="presentation" onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            My Profile
          </h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionHeading}>Profile</h3>

          {profile === undefined && (
            <div className={styles.form}>
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          )}

          {profile === null && (
            <>
              <p role="alert" className={styles.errorBanner}>
                {profileError}
              </p>
              <Button type="button" variant="secondary" onClick={loadProfile}>
                Try again
              </Button>
            </>
          )}

          {profile !== undefined && profile !== null && (
            <form className={styles.form} onSubmit={handleProfileSubmit}>
              {profileError && (
                <p role="alert" className={styles.errorBanner}>
                  {profileError}
                </p>
              )}
              {profileSaved && !profileError && <p className={styles.successNote}>Saved.</p>}

              <div className={styles.row}>
                <label className={styles.field}>
                  <span className={styles.label}>First name</span>
                  <input
                    className={styles.input}
                    value={profileForm.firstName}
                    onChange={(event) => {
                      setProfileSaved(false);
                      setProfileForm({ ...profileForm, firstName: event.target.value });
                    }}
                    required
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Last name</span>
                  <input
                    className={styles.input}
                    value={profileForm.lastName}
                    onChange={(event) => {
                      setProfileSaved(false);
                      setProfileForm({ ...profileForm, lastName: event.target.value });
                    }}
                    required
                  />
                </label>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>Phone</span>
                <input
                  className={styles.input}
                  type="tel"
                  value={profileForm.phone}
                  onChange={(event) => {
                    setProfileSaved(false);
                    setProfileForm({ ...profileForm, phone: event.target.value });
                  }}
                />
              </label>

              <div className={styles.field}>
                <span className={styles.label}>Email</span>
                <span className={styles.readOnlyValue}>{profile.email}</span>
                <p className={styles.hint}>Email can&rsquo;t be changed here.</p>
              </div>

              {isOffline && (
                <p role="alert" className={styles.errorBanner}>
                  You&rsquo;re offline — saving is disabled until the connection returns.
                </p>
              )}
              <div className={styles.actionsRow}>
                <Button type="submit" loading={profileSaving} disabled={isOffline}>
                  Save
                </Button>
              </div>
            </form>
          )}
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionHeading}>Change password</h3>
          <form className={styles.form} onSubmit={handlePasswordSubmit}>
            {passwordError && (
              <p role="alert" className={styles.errorBanner}>
                {passwordError}
              </p>
            )}
            {passwordResult !== null && !passwordError && (
              <p role="status" className={styles.successNote}>
                {passwordSuccessMessage(passwordResult)}
              </p>
            )}

            <label className={styles.field}>
              <span className={styles.label}>Current password</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="current-password"
                value={passwordForm.currentPassword}
                onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })}
                required
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>New password</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                value={passwordForm.newPassword}
                onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })}
                required
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Confirm new password</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                value={passwordForm.confirmNewPassword}
                onChange={(event) => setPasswordForm({ ...passwordForm, confirmNewPassword: event.target.value })}
                required
              />
            </label>
            {confirmMismatch && <p className={styles.errorBanner}>New password and confirmation don&rsquo;t match.</p>}

            {isOffline && (
              <p role="alert" className={styles.errorBanner}>
                You&rsquo;re offline — changing your password is disabled until the connection returns.
              </p>
            )}
            <div className={styles.actionsRow}>
              <Button type="submit" loading={passwordSubmitting} disabled={isOffline || confirmMismatch}>
                Change password
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
