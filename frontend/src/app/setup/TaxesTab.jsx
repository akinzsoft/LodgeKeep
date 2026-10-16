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
  return `In use: ${parts.join(', ')}. Switch it off instead.`;
}

/**
 * One group per tax code. A tax is On when it is switched on and still has a live version (open, or its end date has
 * not passed); otherwise Off. Versions are newest first; the row shows the live version when there is one.
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
    const switchedOn = versions.every((v) => v.enabled !== false);
    return {
      code,
      tax_code: code,
      versions,
      liveVersion,
      shown: liveVersion ?? versions[0],
      on: switchedOn && Boolean(liveVersion),
      switchedOn,
      ending: Boolean(liveVersion && liveVersion.effective_to),
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
  // { kind: 'switch', taxCode, enabled } or { kind: 'delete', taxCode } while a tax-level action is being confirmed.
  const [action, setAction] = useState(null);
  const [note, setNote] = useState('');
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
      if (action.kind === 'switch') {
        await setupApi.setTaxEnabled(action.taxCode, { enabled: action.enabled, ...(note.trim() ? { note: note.trim() } : {}) });
      } else {
        await setupApi.deleteTax(action.taxCode, { reason });
      }
      setAction(null);
      await reload();
    } catch (caught) {
      // A refused delete explains itself (how many records use the tax, and to switch it off instead).
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

  function startAction(kind, taxCode, enabled) {
    setNote('');
    setAction({ kind, taxCode, enabled });
  }

  const businessDate = activeProperty?.current_business_date ? String(activeProperty.current_business_date).slice(0, 10) : '';

  // A version is live while it is open or its end date has not passed; a hotel tax with none charges nothing on new bills.
  const isLive = (version) => !version.effective_to || (businessDate !== '' && String(version.effective_to).slice(0, 10) >= businessDate);
  const groups = groupTaxes(taxes ?? [], isLive);
  const taxesOff = groups.filter((g) => !g.on && g.versions.some((v) => v.applies_to === 'all' || v.applies_to === undefined)).map((g) => g.code);

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
                <StatusPill tone={group.on ? 'success' : 'neutral'} label={group.on ? 'On' : 'Off'} />
                {group.on && group.ending && <span className={formStyles.hint}> No tax from {firstUntaxedDay(group.liveVersion)}</span>}
                {group.switchedOn && !group.liveVersion && <span className={formStyles.hint}> Ended {String(group.versions[0].effective_to).slice(0, 10)}</span>}
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
                          <label className={formStyles.switchLabel}>
                            <input
                              type="checkbox"
                              role="switch"
                              checked={group.on}
                              aria-label={`${group.code} charged on new bills`}
                              disabled={isOffline}
                              onChange={() => startAction('switch', group.code, !group.on)}
                            />
                            <span>{group.on ? 'On' : 'Off'}</span>
                          </label>
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
          <p className={formStyles.disabledNotice}>Only a super admin can add a tax, change a rate, switch a tax on or off, or delete a tax.</p>
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

      {action?.kind === 'switch' && (
        <ConfirmDialog
          title={`Switch ${action.taxCode} ${action.enabled ? 'on' : 'off'}`}
          consequence={
            action.enabled
              ? `"${action.taxCode}" is charged on every new bill straight away. Bills already made are not changed.`
              : `"${action.taxCode}" is not charged on any new bill straight away. Bills already made keep the tax they were charged.`
          }
          confirmLabel={submitting ? 'Saving…' : action.enabled ? 'Switch on' : 'Switch off'}
          confirmDisabled={submitting}
          onConfirm={handleAction}
          onCancel={() => setAction(null)}
        >
          <label className={formStyles.field}>
            <span className={formStyles.label}>Note (optional)</span>
            <input className={formStyles.input} value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
          </label>
        </ConfirmDialog>
      )}

      {action?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${action.taxCode}`}
          consequence={`This permanently deletes "${action.taxCode}" and every version of it. It is only allowed if no folio, POS sale or supermarket sale could have used it; otherwise you will be asked to switch it off instead.`}
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
