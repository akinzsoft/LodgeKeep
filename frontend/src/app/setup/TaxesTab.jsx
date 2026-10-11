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
export function TaxesTab({ disabled, isOffline = false, activeProperty = null }) {
  const [taxes, setTaxes] = useState(null);
  const [form, setForm] = useState({
    tax_code: '',
    name: '',
    rate: '',
    effective_from: '',
    is_inclusive: false,
    calculation_method: 'percentage',
    applies_to: 'all',
  });
  const [confirming, setConfirming] = useState(false);
  // { kind: 'deactivate' | 'delete', taxCode } while a tax-level action is being confirmed.
  const [action, setAction] = useState(null);
  const [deactivateFrom, setDeactivateFrom] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function reload() {
    try {
      setTaxes(await setupApi.listTaxes());
    } catch (caught) {
      // Stops the table showing a loading skeleton forever — the visible
      // error banner below is what actually explains what happened.
      setTaxes([]);
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
        applies_to: form.applies_to,
        reason,
      });
      setForm({ tax_code: '', name: '', rate: '', effective_from: '', is_inclusive: false, calculation_method: 'percentage', applies_to: 'all' });
      setConfirming(false);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the tax version.');
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(reason) {
    setSubmitting(true);
    setError(null);
    try {
      if (action.kind === 'deactivate') {
        await setupApi.deactivateTax(action.taxCode, { reason, ...(deactivateFrom ? { deactivate_from: deactivateFrom } : {}) });
      } else {
        await setupApi.deleteTax(action.taxCode, { reason });
      }
      setAction(null);
      await reload();
    } catch (caught) {
      // A refused delete explains itself (how many records use the tax, and to deactivate instead).
      setError(caught instanceof ApiError ? caught.message : 'Could not complete that action.');
      setAction(null);
    } finally {
      setSubmitting(false);
    }
  }

  function startAction(kind, taxCode) {
    setDeactivateFrom('');
    setAction({ kind, taxCode });
  }

  const businessDate = activeProperty?.current_business_date ? String(activeProperty.current_business_date).slice(0, 10) : '';

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
          { key: 'applies_to', label: 'Applies to', render: (row) => (row.applies_to === 'supermarket_sale' ? 'Supermarket sales' : row.applies_to === 'all' ? 'All hotel charges' : row.applies_to) },
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
          {
            key: 'actions',
            label: 'Actions',
            render: (row) => {
              // Actions apply to the whole tax, so they sit on its newest version only.
              const isLatest = taxes.find((v) => v.tax_code === row.tax_code)?.id === row.id;
              if (!isLatest) return null;
              return (
                <span className={formStyles.actionsRow}>
                  {isCurrentlyOpen(row) && (
                    <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startAction('deactivate', row.tax_code)}>
                      Deactivate
                    </Button>
                  )}
                  <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startAction('delete', row.tax_code)}>
                    Delete
                  </Button>
                </span>
              );
            },
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
          alters what a historical folio already recorded.
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
            <div className={formStyles.field}>
              <label htmlFor="tax-applies-to" className={formStyles.label}>
                Applies to
              </label>
              <select id="tax-applies-to" className={formStyles.select} value={form.applies_to} onChange={(event) => setForm({ ...form, applies_to: event.target.value })}>
                <option value="all">All hotel charges</option>
                <option value="supermarket_sale">Supermarket sales only</option>
              </select>
              <span className={formStyles.hint}>Supermarket sales are taxed only by rows set to &quot;Supermarket sales only&quot;; an &quot;All hotel charges&quot; row never applies to them.</span>
            </div>
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

          {/* DESIGN_SYSTEM.md §2 names "change a tax rate" directly as a financial action to disable while offline. */}
          {isOffline && (
            <p role="alert" className={formStyles.errorBanner}>
              You&rsquo;re offline — changing a tax rate is disabled until the connection returns.
            </p>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" disabled={isOffline}>
              Save tax version
            </Button>
          </div>
        </form>
      </Card>

      {action?.kind === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${action.taxCode}`}
          consequence={`"${action.taxCode}" stops applying to new charges from the date below. Folios, receipts and reports already recorded keep the tax they were charged. To bring it back later, add a new version.`}
          requireReason
          confirmLabel={submitting ? 'Saving…' : 'Deactivate'}
          confirmDisabled={submitting || (deactivateFrom !== '' && businessDate !== '' && deactivateFrom < businessDate)}
          onConfirm={handleAction}
          onCancel={() => setAction(null)}
        >
          <label className={formStyles.field}>
            <span className={formStyles.label}>Stops applying from</span>
            <input
              className={formStyles.input}
              type="date"
              value={deactivateFrom || businessDate}
              min={businessDate || undefined}
              onChange={(event) => setDeactivateFrom(event.target.value)}
            />
            <span className={formStyles.hint}>Defaults to the business date. Past dates are not allowed.</span>
          </label>
        </ConfirmDialog>
      )}

      {action?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${action.taxCode}`}
          consequence={`This permanently deletes "${action.taxCode}" and every version of it. It is only allowed if no folio, POS sale or supermarket sale could have used it; otherwise you will be asked to deactivate it instead.`}
          requireReason
          confirmLabel={submitting ? 'Deleting…' : 'Delete tax'}
          confirmDisabled={submitting}
          onConfirm={handleAction}
          onCancel={() => setAction(null)}
        />
      )}

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
