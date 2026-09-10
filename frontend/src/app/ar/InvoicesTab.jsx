import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { arApi, profilesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './ARForm.module.css';

const STATUS_PILL = {
  issued: { tone: 'info', label: 'Issued' },
  partially_paid: { tone: 'warning', label: 'Partially paid' },
  paid: { tone: 'success', label: 'Paid' },
  void: { tone: 'neutral', label: 'Void' },
};

/**
 * InvoicesTab — PLAN.md Phase 4 (Accounts Receivable), TESTING.md AR-1.
 * Filtered by account (a per-property list can carry invoices across many
 * companies — the same "start from a lookup" shape `CashieringScreen`'s own
 * Folio Lookup tab already established, since no cross-account "all
 * invoices" endpoint exists). Voiding is void-never-delete on the backend
 * (ARCHITECTURE.md §8) — the row stays visible with a `void` status pill,
 * never removed.
 */
export function InvoicesTab({ isOffline = false }) {
  const [accounts, setAccounts] = useState(null);
  const [companies, setCompanies] = useState(null);
  const [accountId, setAccountId] = useState('');
  const [invoices, setInvoices] = useState(null);
  const [error, setError] = useState(null);

  const [expandedInvoice, setExpandedInvoice] = useState(null);
  const [voidingInvoice, setVoidingInvoice] = useState(null);

  useEffect(() => {
    Promise.all([arApi.listAccounts(), profilesApi.listCompanyProfiles()])
      .then(([accountRows, companyRows]) => {
        setAccounts(accountRows);
        setCompanies(companyRows);
      })
      .catch((caught) => {
        setAccounts([]);
        setCompanies([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load AR accounts.');
      });
  }, []);

  function companyName(companyProfileId) {
    return (companies ?? []).find((c) => String(c.id) === String(companyProfileId))?.name ?? `Company ${companyProfileId}`;
  }

  async function loadInvoices(id) {
    setError(null);
    setInvoices(null);
    try {
      setInvoices(await arApi.listInvoicesForAccount(id));
    } catch (caught) {
      setInvoices([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load invoices for this account.');
    }
  }

  function handleSelectAccount(event) {
    const id = event.target.value;
    setAccountId(id);
    setExpandedInvoice(null);
    if (id) loadInvoices(id);
    else setInvoices(null);
  }

  async function handleExpand(invoice) {
    if (expandedInvoice?.id === invoice.id) {
      setExpandedInvoice(null);
      return;
    }
    try {
      setExpandedInvoice(await arApi.getInvoice(invoice.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this invoice’s line items.');
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Invoice actions are disabled until connectivity returns.</p>}

      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Account</span>
          <select className={formStyles.select} value={accountId} onChange={handleSelectAccount}>
            <option value="">Select an account</option>
            {(accounts ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {companyName(account.company_profile_id)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {accountId && (
        <DataTable
          title="Invoices"
          state={invoices === null ? 'loading' : invoices.length === 0 ? 'empty' : 'success'}
          emptyMessage="No invoices generated yet for this account."
          columns={[
            { key: 'invoice_number', label: 'Invoice #' },
            { key: 'issued_at', label: 'Issued' },
            { key: 'due_at', label: 'Due' },
            { key: 'total_amount', label: 'Total', align: 'right', render: (row) => <Money amount={row.total_amount} currencyCode={row.currency} /> },
            {
              key: 'status',
              label: 'Status',
              render: (row) => {
                const pill = STATUS_PILL[row.status] ?? { tone: 'neutral', label: row.status };
                return <StatusPill tone={pill.tone} label={pill.label} />;
              },
            },
          ]}
          rows={invoices ?? []}
          rowKey={(row) => row.id}
          actions={(row) => (
            <div className={formStyles.actionsRow}>
              <Button size="compact" variant="secondary" onClick={() => handleExpand(row)}>
                {expandedInvoice?.id === row.id ? 'Hide lines' : 'View lines'}
              </Button>
              {row.status !== 'void' && (
                <Button size="compact" variant="danger" disabled={isOffline} onClick={() => setVoidingInvoice(row)}>
                  Void
                </Button>
              )}
            </div>
          )}
        />
      )}

      {expandedInvoice && (
        <Card title={`Invoice ${expandedInvoice.invoice_number} — line items`}>
          <DataTable
            title="Lines"
            state={expandedInvoice.lines.length === 0 ? 'empty' : 'success'}
            emptyMessage="No line items on this invoice."
            columns={[
              { key: 'business_date', label: 'Date' },
              { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
            ]}
            rows={expandedInvoice.lines}
            rowKey={(row) => row.id}
          />
        </Card>
      )}

      {voidingInvoice && (
        <ConfirmDialog
          title="Void invoice"
          consequence={`This voids invoice ${voidingInvoice.invoice_number} (${voidingInvoice.total_amount} ${voidingInvoice.currency}). Its charges will NOT be re-invoiced automatically — post a correcting adjustment on the underlying folio if the charge itself was wrong.`}
          requireReason
          confirmLabel="Void this invoice"
          onConfirm={async (reason) => {
            const target = voidingInvoice;
            setVoidingInvoice(null);
            try {
              await arApi.voidInvoice(target.id, reason);
              await loadInvoices(accountId);
              setExpandedInvoice(null);
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not void this invoice.');
            }
          }}
          onCancel={() => setVoidingInvoice(null)}
        />
      )}
    </div>
  );
}
