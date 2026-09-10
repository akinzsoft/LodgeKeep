import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { profilesApi, arApi, ApiError } from '../../shared/api/index.js';
import formStyles from './ProfilesForm.module.css';

const TYPES = [
  { value: 'company', label: 'Company' },
  { value: 'travel_agent', label: 'Travel agent' },
  { value: 'source', label: 'Source' },
];

const EMPTY_FORM = { name: '', type: 'company', billing_email: '', billing_phone: '', billing_address: '', payment_terms_days: '30' };

/**
 * CompanyProfilesTab — PLAN.md Phase 4 (Accounts Receivable),
 * PRODUCT_REQUIREMENTS.md §3.1's "Company, travel agent, and source
 * profiles ... B2B profiles matter for invoicing/AR" and its profile-detail
 * screen spec's "Company / travel agent profiles as a separate tab — these
 * drive AR invoicing (3.9), so credit limit and outstanding balance belong
 * on this screen." This session's confirmed decision: company-profile CRUD
 * lives in the Profiles module (this file), while `ar_accounts`/invoices/
 * payments live in the new AR module (`app/ar/`) — selecting a company here
 * only shows its AR account SUMMARY (read-only), matching the cross-module
 * service-call pattern already established backend-side
 * (`profiles/service.js`'s own header on `getGuest`/company lookups).
 *
 * The AR-account summary shows the account at the CURRENTLY ACTIVE
 * property only, not "one row per property this company has an account
 * at" — `ar_accounts` is PROPERTY_SCOPED and every other screen in this app
 * is already scoped to the one active property (no cross-property fetch
 * exists anywhere in the frontend); a genuinely multi-property rollup would
 * need a new backend endpoint this pass didn't build. Managing that
 * account (create/edit credit limit, generate invoices, record payments)
 * happens on the AR screen itself, reached by permission
 * (`ar.view`/`ar.manage`) rather than duplicated here.
 */
export function CompanyProfilesTab({ isOffline = false }) {
  const [companies, setCompanies] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [archiving, setArchiving] = useState(null);

  const [selectedCompany, setSelectedCompany] = useState(null);
  const [account, setAccount] = useState(undefined); // undefined = not loaded yet, null = none exists
  const [accountError, setAccountError] = useState(null);

  async function reload(searchQuery) {
    setError(null);
    try {
      setCompanies(await profilesApi.listCompanyProfiles(searchQuery));
    } catch (caught) {
      setCompanies([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load company profiles.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handleSearch(event) {
    event.preventDefault();
    setSearching(true);
    await reload(query);
    setSearching(false);
  }

  function handleClearSearch() {
    setQuery('');
    reload();
  }

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  function startEdit(company) {
    setEditingId(company.id);
    setForm({
      name: company.name ?? '',
      type: company.type ?? 'company',
      billing_email: company.billing_email ?? '',
      billing_phone: company.billing_phone ?? '',
      billing_address: company.billing_address ?? '',
      payment_terms_days: String(company.payment_terms_days ?? 30),
    });
    setFormError(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name,
        type: form.type,
        billingEmail: form.billing_email || undefined,
        billingPhone: form.billing_phone || undefined,
        billingAddress: form.billing_address || undefined,
        paymentTermsDays: form.payment_terms_days ? Number(form.payment_terms_days) : undefined,
      };
      if (editingId) {
        await profilesApi.updateCompanyProfile(editingId, payload);
      } else {
        await profilesApi.createCompanyProfile(payload);
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      await reload(query);
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not save this company profile.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSelect(company) {
    setSelectedCompany(company);
    setAccount(undefined);
    setAccountError(null);
    try {
      const accounts = await arApi.listAccounts();
      setAccount(accounts.find((a) => String(a.company_profile_id) === String(company.id)) ?? null);
    } catch (caught) {
      setAccount(null);
      setAccountError(caught instanceof ApiError ? caught.message : 'Could not load this company’s AR account.');
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <div className={formStyles.actionsRow}>
        <form className={formStyles.row} onSubmit={handleSearch}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Search by name</span>
            <input className={formStyles.input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. Acme" />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={searching}>
              Search
            </Button>
            {query && (
              <Button type="button" variant="ghost" onClick={handleClearSearch}>
                Clear
              </Button>
            )}
          </div>
        </form>
      </div>

      <DataTable
        title="Company profiles"
        state={companies === null ? 'loading' : companies.length === 0 ? 'empty' : 'success'}
        emptyMessage="No company profiles yet — add one below."
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type', render: (row) => TYPES.find((t) => t.value === row.type)?.label ?? row.type },
          { key: 'billing_email', label: 'Billing email', render: (row) => row.billing_email ?? '—' },
        ]}
        rows={companies ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <div className={formStyles.actionsRow}>
            <Button size="compact" variant="secondary" onClick={() => handleSelect(row)}>
              View AR account
            </Button>
            <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startEdit(row)}>
              Edit
            </Button>
            <Button size="compact" variant="danger" disabled={isOffline} onClick={() => setArchiving(row)}>
              Archive
            </Button>
          </div>
        )}
      />

      <Card title={editingId ? 'Edit company profile' : 'Add a company profile'}>
        {formError && (
          <p role="alert" className={formStyles.errorBanner}>
            {formError}
          </p>
        )}
        {isOffline && <p className={formStyles.disabledNotice}>You are offline. Company profile changes are disabled until connectivity returns.</p>}
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Type</span>
              <select className={formStyles.select} value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Billing email</span>
              <input
                type="email"
                className={formStyles.input}
                value={form.billing_email}
                onChange={(event) => setForm({ ...form, billing_email: event.target.value })}
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Billing phone</span>
              <input className={formStyles.input} value={form.billing_phone} onChange={(event) => setForm({ ...form, billing_phone: event.target.value })} />
            </label>
          </div>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Billing address</span>
            <input className={formStyles.input} value={form.billing_address} onChange={(event) => setForm({ ...form, billing_address: event.target.value })} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Payment terms (days)</span>
            <input
              type="number"
              min="0"
              className={formStyles.input}
              value={form.payment_terms_days}
              onChange={(event) => setForm({ ...form, payment_terms_days: event.target.value })}
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              {editingId ? 'Save changes' : 'Add company profile'}
            </Button>
            {editingId && (
              <Button type="button" variant="ghost" onClick={startCreate}>
                Cancel edit
              </Button>
            )}
          </div>
        </form>
      </Card>

      {selectedCompany && (
        <Card title={`AR account — ${selectedCompany.name}`}>
          {accountError && (
            <p role="alert" className={formStyles.errorBanner}>
              {accountError}
            </p>
          )}
          {account === undefined && <p className={formStyles.disabledNotice}>Loading…</p>}
          {account === null && (
            <p className={formStyles.disabledNotice}>
              No AR account exists yet for this company at the active property — create one on the Accounts Receivable screen before billing a folio to it.
            </p>
          )}
          {account && (
            <dl className={formStyles.summaryList}>
              <dt>Credit limit</dt>
              <dd>
                <Money amount={account.credit_limit} currencyCode={account.currency} />
              </dd>
              <dt>Current balance</dt>
              <dd>
                <Money amount={account.current_balance} currencyCode={account.currency} />
              </dd>
              <dt>Enforcement</dt>
              <dd>{account.enforcement_mode === 'flag_only' ? 'Flag only' : 'Block'}</dd>
              <dt>Status</dt>
              <dd>
                {account.is_over_limit ? (
                  <StatusPill tone="danger" label="Over limit" />
                ) : (
                  <StatusPill tone="success" label="Within limit" />
                )}
              </dd>
            </dl>
          )}
        </Card>
      )}

      {archiving && (
        <ConfirmDialog
          title="Archive company profile"
          consequence={`This archives "${archiving.name}". It stops appearing in searches and pickers, but existing AR accounts and invoices referencing it are unaffected.`}
          confirmLabel="Archive"
          onConfirm={async () => {
            setArchiving(null);
            try {
              await profilesApi.archiveCompanyProfile(archiving.id);
              await reload(query);
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not archive this company profile.');
            }
          }}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
