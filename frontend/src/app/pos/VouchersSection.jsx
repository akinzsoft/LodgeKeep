import { useEffect, useState } from 'react';
import { Button, DataTable, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { discountsApi, posApi, ApiError } from '../../shared/api/index.js';
import { VoucherEditForm } from './VoucherEditForm.jsx';
import formStyles from './POSForm.module.css';

const VALUE_PATTERN = /^\d+(\.\d{1,2})?$/;

/** A voucher's worth in words: "10%" or the fixed amount, with its cap when it has one. */
export function describeVoucherValue(voucher, currencyCode) {
  const base = voucher.type === 'percent' ? `${Number(voucher.value)}%` : <Money amount={voucher.value} currencyCode={currencyCode} />;
  return voucher.max_amount ? (
    <>
      {base} (up to <Money amount={voucher.max_amount} currencyCode={currencyCode} />)
    </>
  ) : (
    base
  );
}

function usesText(voucher) {
  return voucher.max_total_uses === null ? `${voucher.used_count} used` : `${voucher.used_count} of ${voucher.max_total_uses} used`;
}

const EMPTY_FORM = { type: 'percent', value: '', maxAmount: '', validFrom: '', validTo: '', maxTotalUses: '', note: '', outletIds: [], overrideLimit: false };

/**
 * VouchersSection — a manager (`discount.manage`) makes vouchers and switches them off. The SERVER generates the code
 * (shown once in the list, with dashes) and decides what the creator's own discount limit allows; a cashier only types
 * the code at the till. A manager can edit one (a used voucher keeps its type, amount and start date); only a super admin
 * can delete one, and only if it was never put on a check.
 */
export function VouchersSection({ currencyCode, isOffline = false, canDelete = false }) {
  const [vouchers, setVouchers] = useState(undefined); // undefined loading, null failed
  const [outlets, setOutlets] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState(null);
  const [deleting, setDeleting] = useState(null);

  async function load() {
    try {
      setVouchers(await discountsApi.listVouchers());
    } catch (caught) {
      setVouchers(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the vouchers.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, the established pattern for these cards
    load();
    posApi
      .listOutlets()
      .then((rows) => setOutlets(rows))
      .catch(() => setOutlets([]));
  }, []);

  const outletName = (id) => outlets.find((outlet) => String(outlet.id) === String(id))?.name ?? `Outlet ${id}`;
  const valueOk = VALUE_PATTERN.test(form.value.trim()) && Number(form.value) > 0;
  const capOk = !form.maxAmount.trim() || (VALUE_PATTERN.test(form.maxAmount.trim()) && Number(form.maxAmount) > 0);
  const usesOk = !form.maxTotalUses.trim() || (/^\d+$/.test(form.maxTotalUses.trim()) && Number(form.maxTotalUses) >= 1);
  const ready = valueOk && capOk && usesOk && form.validTo && !busy && !isOffline;

  async function handleCreate(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const voucher = await discountsApi.createVoucher({
        type: form.type,
        value: form.value.trim(),
        validTo: form.validTo,
        validFrom: form.validFrom || undefined,
        maxAmount: form.maxAmount.trim() || undefined,
        maxTotalUses: form.maxTotalUses.trim() ? Number(form.maxTotalUses) : undefined,
        outletIds: form.outletIds,
        note: form.note.trim() || undefined,
        overrideLimit: form.overrideLimit,
      });
      setCreated(voucher);
      setForm(EMPTY_FORM);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the voucher.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(voucher, reason) {
    setDisabling(null);
    setBusy(true);
    setError(null);
    try {
      if (voucher.status === 'active') await discountsApi.disableVoucher(voucher.id, reason);
      else await discountsApi.enableVoucher(voucher.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(changes) {
    setBusy(true);
    setEditError(null);
    try {
      await discountsApi.updateVoucher(editing.id, changes);
      setEditing(null);
      await load();
    } catch (caught) {
      setEditError(caught instanceof ApiError ? caught.message : 'Could not save the voucher.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(voucher) {
    setDeleting(null);
    setBusy(true);
    setError(null);
    try {
      await discountsApi.deleteVoucher(voucher.id);
      if (editing?.id === voucher.id) setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the voucher. Disable it instead.');
    } finally {
      setBusy(false);
    }
  }

  function toggleOutlet(id) {
    setForm((current) => ({ ...current, outletIds: current.outletIds.includes(id) ? current.outletIds.filter((candidate) => candidate !== id) : [...current.outletIds, id] }));
  }

  return (
    <section aria-label="Vouchers">
      <h3 className={formStyles.label}>Vouchers</h3>
      <p className={formStyles.hint}>
        A voucher takes a set amount or percent off a whole check when a cashier types its code. It cannot be combined with another discount, and cannot be used with card or QR payment yet.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {created && (
        <p role="status" className={formStyles.hint}>
          Voucher created. Its code is <strong>{created.code}</strong>.
        </p>
      )}

      <DataTable
        title="Vouchers"
        state={vouchers === undefined ? 'loading' : vouchers === null ? 'error' : vouchers.length === 0 ? 'empty' : 'success'}
        emptyMessage="No vouchers yet."
        errorMessage="Could not load the vouchers."
        columns={[
          { key: 'code', label: 'Code', render: (row) => <code>{row.code}</code> },
          { key: 'value', label: 'Takes off', render: (row) => describeVoucherValue(row, currencyCode) },
          { key: 'uses', label: 'Uses', render: usesText },
          { key: 'valid', label: 'Valid', render: (row) => `${row.valid_from} to ${row.valid_to}` },
          { key: 'outlets', label: 'Works at', render: (row) => (row.outlet_ids.length ? row.outlet_ids.map(outletName).join(', ') : 'All outlets') },
          { key: 'status', label: 'State', render: (row) => (row.status === 'active' ? 'Active' : 'Disabled') },
          {
            key: 'actions',
            label: '',
            render: (row) => (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isOffline || busy}
                  onClick={() => {
                    setEditError(null);
                    setEditing(row);
                  }}
                >
                  Edit
                </Button>
                {row.status === 'active' ? (
                  <Button type="button" variant="ghost" disabled={isOffline || busy} onClick={() => setDisabling(row)}>
                    Disable
                  </Button>
                ) : (
                  <Button type="button" variant="ghost" disabled={isOffline || busy} onClick={() => handleToggle(row)}>
                    Enable
                  </Button>
                )}
                {canDelete && (
                  <Button type="button" variant="ghost" disabled={isOffline || busy} onClick={() => setDeleting(row)}>
                    Delete
                  </Button>
                )}
              </>
            ),
          },
        ]}
        rows={vouchers ?? []}
        rowKey={(row) => row.id}
      />

      {editing && (
        <VoucherEditForm key={editing.id} voucher={editing} outlets={outlets} busy={busy} error={editError} isOffline={isOffline} onSave={handleSaveEdit} onCancel={() => setEditing(null)} />
      )}

      <form className={formStyles.form} onSubmit={handleCreate} aria-label="New voucher">
        <div className={formStyles.row}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Type</span>
            <select className={formStyles.select} value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              <option value="percent">Percent off</option>
              <option value="fixed">Amount off</option>
            </select>
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>{form.type === 'percent' ? 'Percent' : 'Amount'}</span>
            <input className={formStyles.input} type="text" inputMode="decimal" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} aria-invalid={form.value !== '' && !valueOk} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Most it takes off (optional)</span>
            <input className={formStyles.input} type="text" inputMode="decimal" value={form.maxAmount} onChange={(event) => setForm({ ...form, maxAmount: event.target.value })} aria-invalid={!capOk} />
          </label>
        </div>
        <div className={formStyles.row}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Valid from (optional)</span>
            <input className={formStyles.input} type="date" value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Valid until</span>
            <input className={formStyles.input} type="date" value={form.validTo} onChange={(event) => setForm({ ...form, validTo: event.target.value })} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Uses in total (optional)</span>
            <input className={formStyles.input} type="text" inputMode="numeric" value={form.maxTotalUses} onChange={(event) => setForm({ ...form, maxTotalUses: event.target.value })} aria-invalid={!usesOk} />
          </label>
        </div>
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
        <label className={formStyles.checkboxField}>
          <input className={formStyles.checkbox} type="checkbox" checked={form.overrideLimit} onChange={(event) => setForm({ ...form, overrideLimit: event.target.checked })} /> Allow more than my own discount limit (needs comp authority)
        </label>
        <p className={formStyles.hint}>A voucher can take off at most your own discount limit of a check. A 100% voucher, or one above your limit, needs comp authority.</p>
        <div>
          <Button type="submit" disabled={!ready}>
            Create voucher
          </Button>
        </div>
      </form>

      {deleting && (
        <ConfirmDialog
          title="Delete this voucher?"
          consequence={`Voucher ${deleting.code} is removed for good. This only works if it was never put on a check; if it was, disable it instead.`}
          confirmLabel="Delete"
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {disabling && (
        <ConfirmDialog
          title="Disable this voucher?"
          consequence="It stops working at once, even on a check where it was already typed in. You can enable it again later."
          requireReason
          confirmLabel="Disable"
          onConfirm={(reason) => handleToggle(disabling, reason)}
          onCancel={() => setDisabling(null)}
        />
      )}
    </section>
  );
}
