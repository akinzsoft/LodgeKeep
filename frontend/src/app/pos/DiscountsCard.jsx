import { useEffect, useState } from 'react';
import { Card, Button, DataTable, Toast } from '../../shared/components/index.js';
import { discountsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

const ROLE_LABELS = { pos_operator: 'Cashier / POS operator', manager: 'Manager', admin: 'Admin', super_admin: 'Super admin' };
const KIND_LABELS = { discount: 'Discounts only', comp: 'Comps only', both: 'Discounts and comps' };
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/** 0 to 100 with at most 2 decimals — the server enforces the same rule. */
export function isValidLimit(text) {
  const value = String(text ?? '').trim();
  return PERCENT_PATTERN.test(value) && Number(value) <= 100;
}

/**
 * DiscountsCard — the reasons staff choose from when they give a discount or comp, and how much each role may give
 * without a manager. A change to a limit is audited. Without `discount.manage` it only shows what applies.
 */
export function DiscountsCard({ isOffline = false, canManage = true }) {
  const [reasons, setReasons] = useState(undefined); // undefined loading, null failed
  const [limits, setLimits] = useState(undefined);
  const [drafts, setDrafts] = useState({});
  const [form, setForm] = useState({ code: '', name: '', kind: 'both' });
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [reasonRows, limitRows] = await Promise.all([discountsApi.listReasons({ includeArchived: canManage }), discountsApi.listLimits()]);
      setReasons(reasonRows);
      setLimits(limitRows);
      setDrafts(Object.fromEntries(limitRows.map((row) => [row.role, String(row.max_percent)])));
    } catch (caught) {
      setReasons(null);
      setLimits(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the discount settings.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, the established pattern for these cards
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  async function run(action, success) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setToast(success);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function addReason(event) {
    event.preventDefault();
    run(async () => {
      await discountsApi.createReason({ code: form.code.trim(), name: form.name.trim(), kind: form.kind });
      setForm({ code: '', name: '', kind: 'both' });
    }, 'Reason added.');
  }

  return (
    <Card title="Discounts and comps">
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <h3 className={formStyles.label}>Most each role may give without a manager</h3>
      {limits === undefined ? (
        <p className={formStyles.hint}>Loading…</p>
      ) : limits ? (
        <ul className={formStyles.form}>
          {limits.map((row) => (
            <li key={row.role} className={formStyles.row}>
              <span className={formStyles.label}>{ROLE_LABELS[row.role] ?? row.role}</span>
              {canManage ? (
                <>
                  <input
                    className={formStyles.input}
                    type="text"
                    inputMode="decimal"
                    aria-label={`Limit for ${ROLE_LABELS[row.role] ?? row.role} (%)`}
                    value={drafts[row.role] ?? ''}
                    onChange={(event) => setDrafts({ ...drafts, [row.role]: event.target.value })}
                    aria-invalid={!isValidLimit(drafts[row.role])}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isOffline || busy || !isValidLimit(drafts[row.role]) || Number(drafts[row.role]) === Number(row.max_percent)}
                    onClick={() => run(() => discountsApi.setLimit(row.role, drafts[row.role].trim()), 'Limit saved.')}
                  >
                    Save
                  </Button>
                </>
              ) : (
                <span>{String(row.max_percent)}%</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={formStyles.hint}>The limits could not be loaded.</p>
      )}
      <p className={formStyles.hint}>A discount above a role&rsquo;s limit, and every comp, waits for a manager&rsquo;s PIN. Comps always need a manager.</p>

      <DataTable
        title="Reasons"
        state={reasons === undefined ? 'loading' : reasons === null ? 'error' : reasons.length === 0 ? 'empty' : 'success'}
        emptyMessage="No reasons yet."
        errorMessage="Could not load the reasons."
        columns={[
          { key: 'name', label: 'Reason' },
          { key: 'kind', label: 'For', render: (row) => KIND_LABELS[row.kind] ?? row.kind },
          { key: 'status', label: 'Status', render: (row) => (row.status === 'active' ? 'In use' : 'Archived') },
          ...(canManage
            ? [
                {
                  key: 'actions',
                  label: '',
                  render: (row) => (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isOffline || busy}
                      onClick={() => run(() => discountsApi.updateReason(row.id, { status: row.status === 'active' ? 'archived' : 'active' }), row.status === 'active' ? 'Reason archived.' : 'Reason restored.')}
                    >
                      {row.status === 'active' ? 'Archive' : 'Restore'}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
        rows={reasons ?? []}
        rowKey={(row) => row.id}
      />

      {canManage && (
        <form className={formStyles.form} onSubmit={addReason}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={80} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input className={formStyles.input} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} maxLength={30} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>For</span>
              <select className={formStyles.select} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <Button type="submit" disabled={isOffline || busy || !form.name.trim() || !form.code.trim()}>
              Add reason
            </Button>
          </div>
          {isOffline && <p className={formStyles.hint}>You are offline — changes are disabled.</p>}
        </form>
      )}

      {toast && (
        <div className={formStyles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </Card>
  );
}
