import { useEffect, useState } from 'react';
import { Card, Button, Toast, ConfirmDialog, StatusPill } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import { EmailDeliveryNotice } from './EmailDeliveryNotice.jsx';
import formStyles from './SetupForm.module.css';

/**
 * SecurityTab — the admin sign-in verification code (email MFA) for the
 * active property. Everyone with `setup.view` sees the current state; only
 * a super admin (`security.manage`) gets the controls. Turning it OFF needs
 * a confirmation that states the risk and a typed reason (audited, and the
 * other admins get a bell alert); turning it ON needs neither. Platform-
 * staff MFA (authenticator app) is a separate thing and is never affected.
 */
export function SecurityTab({ activeProperty, isOffline = false }) {
  const [settings, setSettings] = useState(undefined); // undefined = loading
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const propertyId = activeProperty?.id;

  useEffect(() => {
    if (!propertyId) return undefined;
    let cancelled = false;
    setupApi
      .getSecuritySettings(propertyId)
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch((caught) => {
        if (cancelled) return;
        setSettings(null);
        setError(caught instanceof ApiError ? caught.message : 'Could not load security settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  if (!activeProperty) {
    return <p className={formStyles.hint}>Choose a property from the Property box in the top bar to see its security settings.</p>;
  }

  async function change(required, reason) {
    setBusy(true);
    setError(null);
    try {
      const result = await setupApi.setMfaRequirement(propertyId, { required, reason });
      setSettings((current) => ({ ...current, mfaRequiredForAdminRoles: result.mfaRequiredForAdminRoles }));
      setSavedCount((count) => count + 1);
      setToast(required ? 'Verification code is now required' : 'Verification code turned off');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the change.');
    } finally {
      setBusy(false);
      setConfirmingOff(false);
    }
  }

  const required = settings?.mfaRequiredForAdminRoles;
  const canManage = Boolean(settings?.canManage);

  return (
    <Card title="Sign-in security">
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      <EmailDeliveryNotice where="security" refreshKey={savedCount} />

      {settings === undefined && !error && <p className={formStyles.hint}>Loading…</p>}

      {settings && (
        <>
          <p>
            <strong>Verification code for admin sign-in</strong>{' '}
            <StatusPill tone={required ? 'success' : 'warning'} label={required ? 'Required' : 'Off'} />
          </p>
          <p className={formStyles.hint}>
            {required
              ? 'Admins and super admins must enter a code emailed to them after their password.'
              : 'Admins and super admins sign in with their password only. A stolen password gives full access.'}{' '}
            This does not affect Planmsys platform staff, who always use an authenticator app.
          </p>

          {canManage ? (
            required ? (
              <Button variant="secondary" disabled={isOffline || busy} onClick={() => setConfirmingOff(true)}>
                Turn off verification code…
              </Button>
            ) : (
              <Button disabled={isOffline || busy} loading={busy} onClick={() => change(true)}>
                Require verification code
              </Button>
            )
          ) : (
            <p className={formStyles.hint}>Only a super admin can change this.</p>
          )}
          {isOffline && <p className={formStyles.hint}>You are offline — changes are disabled.</p>}
        </>
      )}

      {confirmingOff && (
        <ConfirmDialog
          title="Turn off the verification code?"
          consequence="Disabling this removes two-factor protection for admin accounts — a stolen password would grant full access. Other admins will be alerted."
          requireReason
          confirmLabel="Turn off"
          confirmDisabled={busy}
          onConfirm={(reason) => change(false, reason)}
          onCancel={() => setConfirmingOff(false)}
        />
      )}
      {toast && (
        <div className={formStyles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </Card>
  );
}
