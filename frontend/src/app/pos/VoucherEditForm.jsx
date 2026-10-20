import { useState } from 'react';
import { Button } from '../../shared/components/index.js';
import formStyles from './POSForm.module.css';

const VALUE_PATTERN = /^\d+(\.\d{1,2})?$/;

function toForm(voucher) {
  return {
    type: voucher.type,
    value: voucher.value,
    maxAmount: voucher.max_amount ?? '',
    validFrom: voucher.valid_from,
    validTo: voucher.valid_to,
    maxTotalUses: voucher.max_total_uses === null ? '' : String(voucher.max_total_uses),
    note: voucher.note ?? '',
    outletIds: voucher.outlet_ids.map(String),
    overrideLimit: false,
  };
}

/** What changed, in the shape `discountsApi.updateVoucher` takes (only the fields that differ). */
export function changesBetween(voucher, form) {
  const before = toForm(voucher);
  const changes = {};
  if (form.type !== before.type) changes.type = form.type;
  if (Number(form.value) !== Number(before.value)) changes.value = form.value.trim();
  if (form.maxAmount.trim() !== before.maxAmount && Number(form.maxAmount || 0) !== Number(before.maxAmount || 0)) changes.maxAmount = form.maxAmount.trim() || null;
  if (form.validFrom !== before.validFrom) changes.validFrom = form.validFrom;
  if (form.validTo !== before.validTo) changes.validTo = form.validTo;
  if (form.maxTotalUses.trim() !== before.maxTotalUses) changes.maxTotalUses = form.maxTotalUses.trim() ? Number(form.maxTotalUses) : null;
  if (form.note.trim() !== (voucher.note ?? '')) changes.note = form.note.trim() || null;
  if ([...form.outletIds].sort().join(',') !== [...before.outletIds].sort().join(',')) changes.outletIds = form.outletIds;
  if (form.overrideLimit && (changes.type !== undefined || changes.value !== undefined)) changes.overrideLimit = true;
  return changes;
}

/**
 * VoucherEditForm — the create fields, pre-filled, with Save and Cancel. The code is shown and never editable. Once a
 * voucher has been used (`money_locked`) its type, amount and start date are fixed, its max-off cap can only be raised
 * or removed, and total uses cannot go below what was used; the server enforces all of it, this just says so up front.
 */
export function VoucherEditForm({ voucher, outlets, busy, error, isOffline, onSave, onCancel }) {
  const [form, setForm] = useState(() => toForm(voucher));
  const locked = Boolean(voucher.money_locked);
  const used = Number(voucher.used_count);
  const hadCap = voucher.max_amount !== null;

  const valueOk = VALUE_PATTERN.test(form.value.trim()) && Number(form.value) > 0 && (form.type !== 'percent' || Number(form.value) <= 100);
  const capOk = !form.maxAmount.trim() || (VALUE_PATTERN.test(form.maxAmount.trim()) && Number(form.maxAmount) > 0 && (!locked || (hadCap && Number(form.maxAmount) >= Number(voucher.max_amount))));
  const capAddedWhileLocked = locked && hadCap === false && form.maxAmount.trim() !== '';
  const usesOk = !form.maxTotalUses.trim() || (/^\d+$/.test(form.maxTotalUses.trim()) && Number(form.maxTotalUses) >= Math.max(1, used));
  const datesOk = Boolean(form.validTo) && form.validTo >= form.validFrom;
  const changes = changesBetween(voucher, form);
  const ready = valueOk && capOk && !capAddedWhileLocked && usesOk && datesOk && !busy && !isOffline && Object.keys(changes).length > 0;

  function toggleOutlet(id) {
    setForm((current) => ({ ...current, outletIds: current.outletIds.includes(id) ? current.outletIds.filter((candidate) => candidate !== id) : [...current.outletIds, id] }));
  }

  return (
    <form
      className={formStyles.form}
      aria-label={`Edit voucher ${voucher.code}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSave(changes);
      }}
    >
      <h4 className={formStyles.label}>
        Edit voucher <code>{voucher.code}</code>
      </h4>
      {locked && (
        <p className={formStyles.hint} role="note">
          This voucher has been used, so its type, amount and start date are fixed. You can still change its end date, uses, outlets, note and raise its cap.
        </p>
      )}
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Type</span>
          <select className={formStyles.select} value={form.type} disabled={locked} onChange={(event) => setForm({ ...form, type: event.target.value })}>
            <option value="percent">Percent off</option>
            <option value="fixed">Amount off</option>
          </select>
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{form.type === 'percent' ? 'Percent' : 'Amount'}</span>
          <input className={formStyles.input} type="text" inputMode="decimal" value={form.value} disabled={locked} onChange={(event) => setForm({ ...form, value: event.target.value })} aria-invalid={!valueOk} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Most it takes off (optional)</span>
          <input
            className={formStyles.input}
            type="text"
            inputMode="decimal"
            value={form.maxAmount}
            disabled={locked && !hadCap}
            onChange={(event) => setForm({ ...form, maxAmount: event.target.value })}
            aria-invalid={!capOk}
          />
        </label>
      </div>
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Valid from</span>
          <input className={formStyles.input} type="date" value={form.validFrom} disabled={locked} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Valid until</span>
          <input className={formStyles.input} type="date" value={form.validTo} onChange={(event) => setForm({ ...form, validTo: event.target.value })} required aria-invalid={!datesOk} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Uses in total (optional)</span>
          <input className={formStyles.input} type="text" inputMode="numeric" value={form.maxTotalUses} onChange={(event) => setForm({ ...form, maxTotalUses: event.target.value })} aria-invalid={!usesOk} />
        </label>
      </div>
      {used > 0 && <p className={formStyles.hint}>Used {used} time{used === 1 ? '' : 's'} so far: total uses cannot be set lower.</p>}
      {outlets.length > 0 && (
        <fieldset className={formStyles.checkboxGroup}>
          <legend className={formStyles.label}>Works at (none ticked = every outlet)</legend>
          {outlets.map((outlet) => (
            <label key={outlet.id} className={formStyles.checkboxField}>
              <input className={formStyles.checkbox} type="checkbox" checked={form.outletIds.includes(String(outlet.id))} onChange={() => toggleOutlet(String(outlet.id))} /> {outlet.name}
            </label>
          ))}
        </fieldset>
      )}
      <label className={formStyles.field}>
        <span className={formStyles.label}>Note (optional)</span>
        <input className={formStyles.input} value={form.note} maxLength={200} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </label>
      {!locked && (
        <label className={formStyles.checkboxField}>
          <input className={formStyles.checkbox} type="checkbox" checked={form.overrideLimit} onChange={(event) => setForm({ ...form, overrideLimit: event.target.checked })} /> Allow more than my own discount limit (needs comp authority)
        </label>
      )}
      <div className={formStyles.row}>
        <Button type="submit" disabled={!ready}>
          Save changes
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
