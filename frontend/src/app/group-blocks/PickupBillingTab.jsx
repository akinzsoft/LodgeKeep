import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { groupBlocksApi, arApi, profilesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './GBForm.module.css';

/**
 * PickupBillingTab — PLAN.md Phase 4 (Group Blocks). The pickup progress
 * bar PRODUCT_REQUIREMENTS.md §3.8's own "Back-office screens" line names
 * ("rooms picked up vs blocked"), plus this session's confirmed group-
 * billing shape: when a block has a sponsoring company, its real AR
 * account balance/limit is shown (matched client-side against
 * `arApi.listAccounts()`, the same approach `CompanyProfilesTab` already
 * uses — AR accounts are PROPERTY_SCOPED, group_blocks references a
 * TENANT_SCOPED company id, no joined read exists), with a "Bill rooming
 * list to sponsor" bulk action and a "Generate invoice for this block"
 * action layered on top of AR's own existing account/invoice machinery.
 * When unsponsored, both actions are replaced with a plain explanation —
 * an unsponsored block genuinely has no consolidated master bill.
 */
export function PickupBillingTab({ isOffline = false, block }) {
  const [pickup, setPickup] = useState(null);
  const [account, setAccount] = useState(null);
  const [companyName, setCompanyName] = useState(null);
  const [error, setError] = useState(null);

  const [billing, setBilling] = useState(false);
  const [confirmingBill, setConfirmingBill] = useState(false);
  const [billResult, setBillResult] = useState(null);

  const [generating, setGenerating] = useState(false);
  const [generateMessage, setGenerateMessage] = useState(null);

  async function reload() {
    if (!block) return;
    setError(null);
    try {
      const summary = await groupBlocksApi.getPickupSummary(block.id);
      setPickup(summary);
      if (block.company_profile_id) {
        const [accounts, companies] = await Promise.all([arApi.listAccounts(), profilesApi.listCompanyProfiles()]);
        setAccount(accounts.find((a) => String(a.company_profile_id) === String(block.company_profile_id)) ?? null);
        setCompanyName(companies.find((c) => String(c.id) === String(block.company_profile_id))?.name ?? `Company ${block.company_profile_id}`);
      } else {
        setAccount(null);
        setCompanyName(null);
      }
    } catch (caught) {
      setPickup(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load this block\'s pickup and billing status.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount/block-change; no data-fetching library exists yet to own this
    reload();
  }, [block?.id]);

  async function handleBillToSponsor() {
    setConfirmingBill(false);
    setBilling(true);
    setBillResult(null);
    setError(null);
    try {
      const result = await groupBlocksApi.billToSponsor(block.id);
      setBillResult(result);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not bill this rooming list to its sponsor.');
    } finally {
      setBilling(false);
    }
  }

  async function handleGenerateInvoice() {
    setGenerating(true);
    setGenerateMessage(null);
    setError(null);
    try {
      const invoice = await arApi.generateInvoice(account.id, { groupBlockId: block.id });
      setGenerateMessage(`Invoice ${invoice.invoice_number} generated — ${invoice.total_amount} ${invoice.currency}.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not generate an invoice for this block.');
    } finally {
      setGenerating(false);
    }
  }

  if (!block) {
    return <p className={formStyles.hint}>Select a block from the Blocks tab (its &quot;Manage&quot; action) to see its pickup and billing status.</p>;
  }

  const pct = pickup && pickup.totalRoomsBlocked > 0 ? Math.min(100, Math.round((pickup.totalRoomsPickedUp / pickup.totalRoomsBlocked) * 100)) : 0;

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Billing actions are disabled until connectivity returns.</p>}

      <Card title={`Pickup — ${block.block_name}`}>
        {pickup ? (
          <>
            <p className={formStyles.hint}>
              {pickup.totalRoomsPickedUp} of {pickup.totalRoomsBlocked} blocked rooms picked up ({pct}%).
            </p>
            <div className={formStyles.progressTrack}>
              <div className={formStyles.progressFill} style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : (
          <p className={formStyles.hint}>Loading…</p>
        )}
      </Card>

      <DataTable
        title="Pickup by room type and night"
        state={pickup === null ? 'loading' : pickup.rows.length === 0 ? 'empty' : 'success'}
        emptyMessage="No room allocations or pickup yet for this block."
        columns={[
          { key: 'stayDate', label: 'Night' },
          { key: 'roomTypeId', label: 'Room type' },
          { key: 'roomsBlocked', label: 'Blocked', align: 'right' },
          { key: 'roomsPickedUp', label: 'Picked up', align: 'right' },
        ]}
        rows={pickup?.rows ?? []}
        rowKey={(row) => `${row.roomTypeId}-${row.stayDate}`}
      />

      <Card title="Group billing">
        {!block.company_profile_id ? (
          <p className={formStyles.hint}>This block has no sponsoring company — each reservation in it settles its own folio individually. Set a sponsor from the Blocks tab to enable consolidated billing.</p>
        ) : !account ? (
          <p className={formStyles.hint}>
            {companyName} sponsors this block but has no active AR account yet — create one on the Accounts Receivable screen before billing this rooming list.
          </p>
        ) : (
          <>
            <p className={formStyles.hint}>
              Sponsored by <strong>{companyName}</strong> —{' '}
              <span className={account.is_over_limit ? formStyles.balanceOwing : undefined}>
                <Money amount={account.current_balance} currencyCode={account.currency} /> of <Money amount={account.credit_limit} currencyCode={account.currency} /> limit
              </span>{' '}
              {account.is_over_limit && <StatusPill tone="danger" label="Over limit" />}
            </p>
            {billResult && (
              <p className={formStyles.hint}>
                Billed {billResult.billed.length} folio(s) to {companyName}
                {billResult.skipped.length > 0 ? `; ${billResult.skipped.length} skipped (already settled, closed, or billed elsewhere).` : '.'}
              </p>
            )}
            {generateMessage && <p className={formStyles.hint}>{generateMessage}</p>}
            <div className={formStyles.actionsRow}>
              <Button disabled={isOffline} loading={billing} onClick={() => setConfirmingBill(true)}>
                Bill rooming list to sponsor
              </Button>
              <Button variant="secondary" disabled={isOffline} loading={generating} onClick={handleGenerateInvoice}>
                Generate invoice for this block
              </Button>
            </div>
          </>
        )}
      </Card>

      {confirmingBill && (
        <ConfirmDialog
          title="Bill rooming list to sponsor"
          consequence={`This bills every open, not-yet-billed folio among ${block.block_name}'s reservations to ${companyName}'s AR account, subject to its credit limit. Already-billed or closed folios are skipped, not double-billed.`}
          confirmLabel="Bill to sponsor"
          onConfirm={handleBillToSponsor}
          onCancel={() => setConfirmingBill(false)}
        />
      )}
    </div>
  );
}
