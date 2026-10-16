import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/** The stored effective_to is the last taxed day; the first untaxed day is the one after it (UTC-safe). */
function firstUntaxedDay(version) {
  const [y, m, d] = String(version.effective_to).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const STATE_LABEL = { current: 'Current', ending: 'Scheduled to end', inactive: 'Inactive' };

function appliesToLabel(appliesTo) {
  return appliesTo === 'supermarket_sale' ? 'Supermarket sales' : appliesTo === 'all' || appliesTo === undefined ? 'All hotel charges' : appliesTo;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Why Delete is unavailable, with the counts the server found. Zero counts are left out. */
function deleteBlockedReason(usage) {
  const parts = [
    usage.folioTaxLines > 0 && plural(usage.folioTaxLines, 'folio tax line'),
    usage.posSettlements > 0 && plural(usage.posSettlements, 'POS sale'),
    usage.supermarketSales > 0 && plural(usage.supermarketSales, 'supermarket sale'),
  ].filter(Boolean);
  return `In use: ${parts.join(', ')}. Deactivate instead.`;
}

/**
 * One group per tax code. State: Current (an open version), Scheduled to end (closed, but the end date has not
 * passed), otherwise Inactive. Versions are newest first; the row shows the live version when there is one.
 */
function groupTaxes(rows, isLive) {
  const byCode = new Map();
  for (const row of rows) {
    if (!byCode.has(row.tax_code)) byCode.set(row.tax_code, []);
    byCode.get(row.tax_code).push(row);
  }
  return [...byCode].map(([code, list]) => {
    const versions = [...list].sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
    const open = versions.find((v) => !v.effective_to);
    const liveVersion = open ?? versions.find(isLive);
    return {
      code,
      tax_code: code,
      versions,
      liveVersion,
      shown: liveVersion ?? versions[0],
      state: open ? 'current' : liveVersion ? 'ending' : 'inactive',
    };
  });
}

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
 * One row per tax; its History lists every version, so a property can see for itself that changing a rate created a
 * new version rather than rewriting history (ARCHITECTURE.md §12.1).
 */
export function TaxesTab({ disabled, isOffline = false, activeProperty = null, canManage = false }) {
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
  // { kind: 'deactivate' | 'reactivate' | 'delete', taxCode } while a tax-level action is being confirmed.
  const [action, setAction] = useState(null);
  const [deactivateFrom, setDeactivateFrom] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

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
      } else if (action.kind === 'changeEnd') {
        await setupApi.changeTaxEndDate(action.taxCode, { reason, end_from: deactivateFrom });
      } else if (action.kind === 'reactivate') {
        await setupApi.reactivateTax(action.taxCode, { reason, ...(deactivateFrom ? { reactivate_from: deactivateFrom } : {}) });
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

  function toggleHistory(code) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function startAction(kind, taxCode, initialDate = '') {
    setDeactivateFrom(initialDate);
    setAction({ kind, taxCode });
  }

  const businessDate = activeProperty?.current_business_date ? String(activeProperty.current_business_date).slice(0, 10) : '';

  // A version is live while it is open or its end date has not passed; a hotel tax with none charges nothing on new bills.
  const isLive = (version) => !version.effective_to || (businessDate !== '' && String(version.effective_to).slice(0, 10) >= businessDate);
  const groups = groupTaxes(taxes ?? [], isLive);
  const taxesOff = groups.filter((g) => !g.liveVersion && g.versions.some((v) => v.applies_to === 'all' || v.applies_to === undefined)).map((g) => g.code);
  const pastDate = deactivateFrom !== '' && businessDate !== '' && deactivateFrom < businessDate;
  const changeEndGroup = action?.kind === 'changeEnd' ? groups.find((g) => g.code === action.taxCode) : null;
  const changeEndStart = changeEndGroup ? String(changeEndGroup.liveVersion.effective_from).slice(0, 10) : '';
  const endNotAfterStart = changeEndStart !== '' && deactivateFrom !== '' && deactivateFrom <= changeEndStart;

  return (
    <div className={styles.page}>
      {taxesOff.map((code) => (
        <p key={code} role="status" className={formStyles.errorBanner}>
          {code} is off: new bills carry no tax
        </p>
      ))}
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      <DataTable
        title="Taxes"
        state={taxes === null ? 'loading' : groups.length === 0 ? 'empty' : 'success'}
        emptyMessage="No taxes configured yet — add one below."
        columns={[
          { key: 'tax_code', label: 'Code' },
          { key: 'name', label: 'Name', render: (group) => group.shown.name },
          { key: 'rate', label: 'Rate', align: 'right', render: (group) => `${group.shown.rate}${group.shown.calculation_method === 'percentage' ? '%' : ''}` },
          { key: 'applies_to', label: 'Applies to', render: (group) => appliesToLabel(group.shown.applies_to) },
          {
            key: 'state',
            label: 'Status',
            render: (group) => (
              <span>
                <StatusPill tone={group.state === 'current' ? 'success' : group.state === 'ending' ? 'warning' : 'neutral'} label={STATE_LABEL[group.state]} />
                {group.state === 'ending' && <span className={formStyles.hint}> No tax from {firstUntaxedDay(group.liveVersion)}</span>}
              </span>
            ),
          },
          {
            key: 'history',
            label: 'History',
            render: (group) => (
              <Button
                size="compact"
                variant="secondary"
                aria-expanded={expanded.has(group.code)}
                aria-controls={expanded.has(group.code) ? `tax-history-${group.code}` : undefined}
                onClick={() => toggleHistory(group.code)}
              >
                {expanded.has(group.code) ? 'Hide history' : `History (${group.versions.length})`}
              </Button>
            ),
          },
          ...(canManage
            ? [
                {
                  key: 'actions',
                  label: 'Actions',
                  render: (group) => {
                    const { usage } = group.shown; // identical on every version of a code
                    const canDelete = usage ? usage.deletable : true;
                    return (
                      <span>
                        <span className={formStyles.actionsRow}>
                          {group.state === 'current' && (
                            <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startAction('deactivate', group.code)}>
                              Deactivate
                            </Button>
                          )}
                          {group.state === 'ending' && (
                            <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startAction('changeEnd', group.code, firstUntaxedDay(group.liveVersion))}>
                              Change end date
                            </Button>
                          )}
                          {group.state === 'inactive' && (
                            <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startAction('reactivate', group.code)}>
                              Reactivate
                            </Button>
                          )}
                          <Button
                            size="compact"
                            variant="secondary"
                            disabled={isOffline || !canDelete}
                            aria-describedby={canDelete ? undefined : `tax-delete-reason-${group.code}`}
                            onClick={() => startAction('delete', group.code)}
                          >
                            Delete
                          </Button>
                        </span>
                        {!canDelete && (
                          <span id={`tax-delete-reason-${group.code}`} className={formStyles.hint}>
                            {deleteBlockedReason(usage)}
                          </span>
                        )}
                      </span>
                    );
                  },
                },
              ]
            : []),
        ]}
        rows={groups}
        rowKey={(group) => group.code}
      />

      {groups
        .filter((group) => expanded.has(group.code))
        .map((group) => (
          <Card key={group.code} title={`${group.code} — history`}>
            <table id={`tax-history-${group.code}`} className={formStyles.historyTable}>
              <thead>
                <tr>
                  <th scope="col">Effective from</th>
                  <th scope="col">Effective to</th>
                  <th scope="col">Rate</th>
                  <th scope="col">Version</th>
                </tr>
              </thead>
              <tbody>
                {group.versions.map((version) => (
                  <tr key={version.id}>
                    <td>{String(version.effective_from).slice(0, 10)}</td>
                    <td>{version.effective_to ? String(version.effective_to).slice(0, 10) : '—'}</td>
                    <td>{`${version.rate}${version.calculation_method === 'percentage' ? '%' : ''}`}</td>
                    <td>
                      <StatusPill tone={version.effective_to ? 'neutral' : 'success'} label={version.effective_to ? 'Historical' : 'Current'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}

      {!canManage ? (
        <Card title="Add a tax or change a rate">
          <p className={formStyles.disabledNotice}>Only a super admin can add a tax, change a rate, or reactivate, deactivate or delete a tax.</p>
        </Card>
      ) : (
      <Card title="Add a tax or change a rate">
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
      )}

      {action?.kind === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${action.taxCode}`}
          consequence={`"${action.taxCode}" stops applying to new charges from the date below. Folios, receipts and reports already recorded keep the tax they were charged. To bring it back later, add a new version.`}
          requireReason
          confirmLabel={submitting ? 'Saving…' : 'Deactivate'}
          confirmDisabled={submitting || pastDate}
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

      {action?.kind === 'changeEnd' && (
        <ConfirmDialog
          title={`Change end date of ${action.taxCode}`}
          consequence={`"${action.taxCode}" is charged on bills dated before the date below and not on that date or after. Folios, receipts and reports already recorded keep the tax they were charged.`}
          requireReason
          confirmLabel={submitting ? 'Saving…' : 'Change end date'}
          confirmDisabled={submitting || pastDate || endNotAfterStart || deactivateFrom === ''}
          onConfirm={handleAction}
          onCancel={() => setAction(null)}
        >
          <label className={formStyles.field}>
            <span className={formStyles.label}>No tax from</span>
            <input
              className={formStyles.input}
              type="date"
              value={deactivateFrom}
              min={businessDate || undefined}
              onChange={(event) => setDeactivateFrom(event.target.value)}
            />
            <span className={formStyles.hint}>
              The first day the tax is not charged. It can be the business date, not an earlier day, and must be after the start date ({changeEndStart}).
            </span>
          </label>
        </ConfirmDialog>
      )}

      {action?.kind === 'reactivate' && (
        <ConfirmDialog
          title={`Reactivate ${action.taxCode}`}
          consequence={`"${action.taxCode}" starts applying again from the date below, with the same rate and settings as its last version. Bills dated before that date, including any in the gap, stay untaxed.`}
          requireReason
          confirmLabel={submitting ? 'Saving…' : 'Reactivate'}
          confirmDisabled={submitting || pastDate}
          onConfirm={handleAction}
          onCancel={() => setAction(null)}
        >
          <label className={formStyles.field}>
            <span className={formStyles.label}>Applies again from</span>
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
