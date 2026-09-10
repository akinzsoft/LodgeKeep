import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { arApi, profilesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './ARForm.module.css';

const ENFORCEMENT_MODES = [
  { value: 'block', label: 'Block' },
  { value: 'flag_only', label: 'Flag only' },
];

/**
 * AccountsTab — PLAN.md Phase 4 (Accounts Receivable), TESTING.md AR-3's
 * "charge over credit limit — blocked or flagged per config": the
 * enforcement mode is this account's own configuration, editable here.
 * Company names are resolved client-side against `GET /companies` — the
 * backend's `ar_accounts` rows carry only `company_profile_id`
 * (`ar/service.js`'s `listAccounts`), since `ar_accounts` is PROPERTY_SCOPED
 * while `company_profiles` is TENANT_SCOPED and no joined read exists yet.
 * "Generate Invoice" is per-row rather than a Bulk action — TESTING.md AR-1
 * is proven per account, and generating for every account at once isn't
 * something PRODUCT_REQUIREMENTS.md §3.9 asks for.
 */
export function AccountsTab({ isOffline = false }) {
  const [accounts, setAccounts] = useState(null);
  const [companies, setCompanies] = useState(null);
  const [error, setError] = useState(null);

  const [form, setForm] = useState({ company_profile_id: '', currency: '', credit_limit: '0.00', enforcement_mode: 'block' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ credit_limit: '', enforcement_mode: 'block', status: 'active' });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState(null);

  const [generatingId, setGeneratingId] = useState(null);
  const [generateMessage, setGenerateMessage] = useState(null);

  async function reload() {
    setError(null);
    try {
      const [accountRows, companyRows] = await Promise.all([arApi.listAccounts(), profilesApi.listCompanyProfiles()]);
      setAccounts(accountRows);
      setCompanies(companyRows);
    } catch (caught) {
      setAccounts([]);
      setCompanies([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load AR accounts.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  function companyName(companyProfileId) {
    return (companies ?? []).find((c) => String(c.id) === String(companyProfileId))?.name ?? `Company ${companyProfileId}`;
  }

  async function handleCreate(event) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await arApi.createAccount({
        companyProfileId: form.company_profile_id,
        currency: form.currency,
        creditLimit: form.credit_limit,
        enforcementMode: form.enforcement_mode,
      });
      setForm({ company_profile_id: '', currency: '', credit_limit: '0.00', enforcement_mode: 'block' });
      await reload();
    } catch (caught) {
      setCreateError(caught instanceof ApiError ? caught.message : 'Could not create this AR account.');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(account) {
    setEditingId(account.id);
    setEditForm({ credit_limit: account.credit_limit, enforcement_mode: account.enforcement_mode, status: account.status });
    setEditError(null);
  }

  async function handleSaveEdit(event) {
    event.preventDefault();
    setEditSubmitting(true);
    setEditError(null);
    try {
      await arApi.updateAccount(editingId, {
        creditLimit: editForm.credit_limit,
        enforcementMode: editForm.enforcement_mode,
        status: editForm.status,
      });
      setEditingId(null);
      await reload();
    } catch (caught) {
      setEditError(caught instanceof ApiError ? caught.message : 'Could not save changes to this AR account.');
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleGenerateInvoice(account) {
    setGeneratingId(account.id);
    setGenerateMessage(null);
    setError(null);
    try {
      const invoice = await arApi.generateInvoice(account.id);
      setGenerateMessage(`Invoice ${invoice.invoice_number} generated for ${companyName(account.company_profile_id)} — ${invoice.total_amount} ${invoice.currency}.`);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not generate an invoice for this account.');
    } finally {
      setGeneratingId(null);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {generateMessage && <p className={formStyles.disabledNotice}>{generateMessage}</p>}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Accounts Receivable actions are disabled until connectivity returns.</p>}

      <DataTable
        title="AR accounts"
        state={accounts === null ? 'loading' : accounts.length === 0 ? 'empty' : 'success'}
        emptyMessage="No AR accounts yet at this property — add one below."
        columns={[
          { key: 'company', label: 'Company', render: (row) => companyName(row.company_profile_id) },
          { key: 'credit_limit', label: 'Credit limit', align: 'right', render: (row) => <Money amount={row.credit_limit} currencyCode={row.currency} /> },
          {
            key: 'current_balance',
            label: 'Balance',
            align: 'right',
            render: (row) => (
              <span className={row.is_over_limit ? formStyles.balanceOwing : undefined}>
                <Money amount={row.current_balance} currencyCode={row.currency} />
              </span>
            ),
          },
          { key: 'enforcement_mode', label: 'Enforcement', render: (row) => ENFORCEMENT_MODES.find((m) => m.value === row.enforcement_mode)?.label ?? row.enforcement_mode },
          {
            key: 'status',
            label: 'Status',
            render: (row) =>
              row.is_over_limit ? (
                <StatusPill tone="danger" label="Over limit" />
              ) : row.status === 'closed' ? (
                <StatusPill tone="neutral" label="Closed" />
              ) : (
                <StatusPill tone="success" label="Within limit" />
              ),
          },
        ]}
        rows={accounts ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <div className={formStyles.actionsRow}>
            <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startEdit(row)}>
              Edit
            </Button>
            <Button size="compact" variant="secondary" disabled={isOffline} loading={generatingId === row.id} onClick={() => handleGenerateInvoice(row)}>
              Generate Invoice
            </Button>
          </div>
        )}
      />

      {editingId && (
        <Card title="Edit AR account">
          {editError && (
            <p role="alert" className={formStyles.errorBanner}>
              {editError}
            </p>
          )}
          <form className={formStyles.form} onSubmit={handleSaveEdit}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Credit limit</span>
                <input
                  className={formStyles.input}
                  value={editForm.credit_limit}
                  onChange={(event) => setEditForm({ ...editForm, credit_limit: event.target.value })}
                  placeholder="0.00"
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Enforcement</span>
                <select
                  className={formStyles.select}
                  value={editForm.enforcement_mode}
                  onChange={(event) => setEditForm({ ...editForm, enforcement_mode: event.target.value })}
                >
                  {ENFORCEMENT_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Status</span>
                <select className={formStyles.select} value={editForm.status} onChange={(event) => setEditForm({ ...editForm, status: event.target.value })}>
                  <option value="active">Active</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
            </div>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={editSubmitting} disabled={isOffline}>
                Save changes
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Add an AR account">
        {createError && (
          <p role="alert" className={formStyles.errorBanner}>
            {createError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreate}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Company</span>
              <select
                className={formStyles.select}
                value={form.company_profile_id}
                onChange={(event) => setForm({ ...form, company_profile_id: event.target.value })}
                required
              >
                <option value="" disabled>
                  Select a company
                </option>
                {(companies ?? []).map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Currency</span>
              <input
                className={formStyles.input}
                value={form.currency}
                onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })}
                placeholder="NGN"
                maxLength={3}
                required
              />
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Credit limit</span>
              <input
                className={formStyles.input}
                value={form.credit_limit}
                onChange={(event) => setForm({ ...form, credit_limit: event.target.value })}
                placeholder="0.00"
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Enforcement</span>
              <select
                className={formStyles.select}
                value={form.enforcement_mode}
                onChange={(event) => setForm({ ...form, enforcement_mode: event.target.value })}
              >
                {ENFORCEMENT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={creating} disabled={isOffline}>
              Add AR account
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
