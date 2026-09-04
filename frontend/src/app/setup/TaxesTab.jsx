import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/**
 * TaxesTab — PRODUCT_REQUIREMENTS.md's "Tax configuration — rate, name,
 * applicability, effective-from date. Changing a tax rate must warn plainly
 * that it applies going forward and does not alter historical folios," and
 * DESIGN_SYSTEM.md §2's named example for a required confirmation step:
 * "change a tax rate ... requires an explicit confirm step ... require a
 * reason field, which feeds the audit trail." `ConfirmDialog`'s
 * `requireReason` is exactly that; the reason is threaded straight to
 * `POST /taxes`, which the backend's controller passes to `req.audit(...)`.
 *
 * Every version of every tax is listed, not just the current one — a
 * property should be able to see for itself that changing a rate created a
 * new version rather than rewriting history (ARCHITECTURE.md §12.1).
 */
export function TaxesTab({ disabled }) {
  const [taxes, setTaxes] = useState(null);
  const [form, setForm] = useState({
    tax_code: '',
    name: '',
    rate: '',
    effective_from: '',
    is_inclusive: false,
    calculation_method: 'percentage',
  });
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function reload() {
    try {
      setTaxes(await setupApi.listTaxes());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load taxes.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — taxes belong to one property.</p>;
  }

  function isCurrentlyOpen(version) {
    return !version.effective_to;
  }

  async function handleConfirm(reason) {
    setSubmitting(true);
    setError(null);
    try {
      await setupApi.createTaxVersion({
        tax_code: form.tax_code,
        name: form.name,
        rate: form.rate,
        effective_from: form.effective_from,
        is_inclusive: form.is_inclusive,
        calculation_method: form.calculation_method,
        reason,
      });
      setForm({ tax_code: '', name: '', rate: '', effective_from: '', is_inclusive: false, calculation_method: 'percentage' });
      setConfirming(false);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the tax version.');
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <DataTable
        title="Taxes (every version)"
        state={taxes === null ? 'loading' : taxes.length === 0 ? 'empty' : 'success'}
        emptyMessage="No taxes configured yet — add one below."
        columns={[
          { key: 'tax_code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'rate', label: 'Rate', align: 'right', render: (row) => `${row.rate}${row.calculation_method === 'percentage' ? '%' : ''}` },
          { key: 'effective_from', label: 'Effective from' },
          { key: 'effective_to', label: 'Effective to', render: (row) => row.effective_to ?? '—' },
          {
            key: 'status',
            label: 'Status',
            render: (row) =>
              isCurrentlyOpen(row) ? (
                <StatusPill tone="success" label="Current" />
              ) : (
                <StatusPill tone="neutral" label="Historical" />
              ),
          },
        ]}
        rows={taxes ?? []}
        rowKey={(row) => row.id}
      />

      <Card title="Add a tax or change a rate">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <p className={formStyles.disabledNotice}>
          Changing an existing tax code&rsquo;s rate creates a new version effective from the date below. It never
          alters what a historical folio already recorded (ARCHITECTURE.md §12.1).
        </p>
        <form
          className={formStyles.form}
          onSubmit={(event) => {
            event.preventDefault();
            setConfirming(true);
          }}
        >
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Tax code</span>
              <input
                className={formStyles.input}
                value={form.tax_code}
                onChange={(event) => setForm({ ...form, tax_code: event.target.value.toUpperCase() })}
                placeholder="VAT"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input
                className={formStyles.input}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="VAT"
                required
              />
            </label>
          </div>

          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Rate</span>
              <input
                className={formStyles.input}
                inputMode="decimal"
                value={form.rate}
                onChange={(event) => setForm({ ...form, rate: event.target.value })}
                placeholder="7.5000"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Calculation method</span>
              <select
                className={formStyles.select}
                value={form.calculation_method}
                onChange={(event) => setForm({ ...form, calculation_method: event.target.value })}
              >
                <option value="percentage">Percentage</option>
                <option value="flat_amount">Flat amount</option>
              </select>
            </label>
          </div>

          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Effective from</span>
              <input
                className={formStyles.input}
                type="date"
                value={form.effective_from}
                onChange={(event) => setForm({ ...form, effective_from: event.target.value })}
                required
              />
            </label>
            <label className={formStyles.checkboxField}>
              <input
                type="checkbox"
                className={formStyles.checkbox}
                checked={form.is_inclusive}
                onChange={(event) => setForm({ ...form, is_inclusive: event.target.checked })}
              />
              <span className={formStyles.label}>Price already includes this tax</span>
            </label>
          </div>

          <div className={formStyles.actionsRow}>
            <Button type="submit">Save tax version</Button>
          </div>
        </form>
      </Card>

      {confirming && (
        <ConfirmDialog
          title="Confirm tax change"
          consequence={`This creates a new version of "${form.tax_code || form.name}" at ${form.rate}${form.calculation_method === 'percentage' ? '%' : ''}, effective from ${form.effective_from}. It applies going forward only — historical folios keep the rate that was effective when they were posted.`}
          requireReason
          confirmLabel={submitting ? 'Saving…' : 'Confirm change'}
          onConfirm={handleConfirm}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
