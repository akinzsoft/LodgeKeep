import { useState } from 'react';
import { Card, Button, ConfirmDialog, Toast } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

const NO_SERVICE_CHARGE_TYPES = ['supermarket', 'store'];
const PERCENT_PATTERN = /^\d{1,2}(\.\d{1,2})?$/;

/** The text is valid when it is 0 to 30 with at most 2 decimals — the server enforces the same rule. */
export function isValidServiceChargePercent(text) {
  if (!PERCENT_PATTERN.test(text.trim())) return false;
  const [whole, fraction = ''] = text.trim().split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2)) <= 3000;
}

/**
 * OutletServiceChargeCard — the service charge rate the Register adds at this outlet, and whether guest QR
 * orders add it too ("charge") or not ("none", the default). Changing either needs a reason and is audited.
 * Supermarkets and stores never carry a service charge, so the card says so instead of offering a form.
 */
export function OutletServiceChargeCard({ outlet, isOffline = false, canManage = true, onSaved }) {
  const [percent, setPercent] = useState(String(outlet.service_charge_percent ?? '7.50'));
  const [qrMode, setQrMode] = useState(outlet.qr_service_charge_mode ?? 'none');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const title = `Service charge — ${outlet.name}`;
  if (NO_SERVICE_CHARGE_TYPES.includes(outlet.type)) {
    return (
      <Card title={title}>
        <p className={formStyles.hint}>A {outlet.type} has no service charge.</p>
      </Card>
    );
  }
  if (!canManage) {
    return (
      <Card title={title}>
        <p className={formStyles.hint}>
          The Register adds {String(outlet.service_charge_percent)}% here; guest QR orders {outlet.qr_service_charge_mode === 'charge' ? 'add it too' : 'add no service charge'}. Only someone allowed to manage service charges can change this.
        </p>
      </Card>
    );
  }

  const valid = isValidServiceChargePercent(percent);
  const unchanged = valid && Number(percent) === Number(outlet.service_charge_percent) && qrMode === outlet.qr_service_charge_mode;

  async function save(reason) {
    setBusy(true);
    setError(null);
    try {
      await posApi.setOutletServiceCharge(outlet.id, { percent: percent.trim(), qrMode, reason });
      setConfirming(false);
      setToast('Service charge saved.');
      await onSaved?.();
    } catch (caught) {
      setConfirming(false);
      setError(caught instanceof ApiError ? caught.message : 'Could not save the service charge.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={title}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      <form
        className={formStyles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !unchanged) setConfirming(true);
        }}
      >
        <label className={formStyles.field}>
          <span className={formStyles.label}>Register service charge (%)</span>
          <input className={formStyles.input} type="text" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-invalid={!valid} />
        </label>
        {!valid && <p className={formStyles.hint}>Enter a number from 0 to 30 with at most 2 decimals.</p>}
        <label className={formStyles.field}>
          <span className={formStyles.label}>Guest QR orders</span>
          <select className={formStyles.select} value={qrMode} onChange={(e) => setQrMode(e.target.value)}>
            <option value="none">No service charge on QR orders</option>
            <option value="charge">Add this outlet&apos;s service charge to QR orders</option>
          </select>
        </label>
        <p className={formStyles.hint}>
          A change applies to new bills. A card payment already started at the old amount must be restarted. QR orders already placed keep the rate the guest was shown.
        </p>
        <div>
          <Button type="submit" disabled={isOffline || busy || !valid || unchanged}>
            Save service charge
          </Button>
        </div>
        {isOffline && <p className={formStyles.hint}>You are offline — changes are disabled.</p>}
      </form>
      {confirming && (
        <ConfirmDialog
          title="Change the service charge?"
          consequence={`${outlet.name}: Register ${percent.trim()}%, guest QR orders ${qrMode === 'charge' ? 'charged' : 'not charged'}.`}
          requireReason
          confirmLabel="Save"
          confirmDisabled={busy}
          onConfirm={save}
          onCancel={() => setConfirming(false)}
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
