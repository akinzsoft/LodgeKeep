import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { groupBlocksApi, profilesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './GBForm.module.css';

const EMPTY_FORM = { block_name: '', company_profile_id: '', start_date: '', end_date: '', cutoff_date: '', notes: '' };

/**
 * BlocksTab — PLAN.md Phase 4 (Group Blocks). Block CRUD, mirroring AR's
 * own `AccountsTab` shape. Company sponsorship is optional (this session's
 * confirmed decision: a block sponsored by no company has no consolidated
 * master bill) — the picker's first option is always "No sponsor."
 * "Manage" hands the clicked block up to `GroupBlocksScreen`, which
 * switches to the Room Allocations tab with it selected — the same
 * "select once, act across tabs" idiom `CashieringScreen`/`RoomsScreen`
 * already established.
 */
export function BlocksTab({ isOffline = false, onManage }) {
  const [blocks, setBlocks] = useState(null);
  const [companies, setCompanies] = useState(null);
  const [error, setError] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState(null);

  async function reload() {
    setError(null);
    try {
      const [blockRows, companyRows] = await Promise.all([groupBlocksApi.listGroupBlocks(), profilesApi.listCompanyProfiles()]);
      setBlocks(blockRows);
      setCompanies(companyRows);
    } catch (caught) {
      setBlocks([]);
      setCompanies([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load group blocks.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  function companyName(companyProfileId) {
    if (!companyProfileId) return 'No sponsor';
    return (companies ?? []).find((c) => String(c.id) === String(companyProfileId))?.name ?? `Company ${companyProfileId}`;
  }

  async function handleCreate(event) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await groupBlocksApi.createGroupBlock({
        blockName: form.block_name,
        companyProfileId: form.company_profile_id || undefined,
        startDate: form.start_date,
        endDate: form.end_date,
        cutoffDate: form.cutoff_date || undefined,
        notes: form.notes || undefined,
      });
      setForm(EMPTY_FORM);
      await reload();
    } catch (caught) {
      setCreateError(caught instanceof ApiError ? caught.message : 'Could not create this group block.');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(block) {
    setEditingId(block.id);
    setEditForm({
      block_name: block.block_name,
      company_profile_id: block.company_profile_id ?? '',
      start_date: block.start_date,
      end_date: block.end_date,
      cutoff_date: block.cutoff_date ?? '',
      notes: block.notes ?? '',
    });
    setEditError(null);
  }

  async function handleSaveEdit(event) {
    event.preventDefault();
    setEditSubmitting(true);
    setEditError(null);
    try {
      await groupBlocksApi.updateGroupBlock(editingId, {
        blockName: editForm.block_name,
        companyProfileId: editForm.company_profile_id || null,
        startDate: editForm.start_date,
        endDate: editForm.end_date,
        cutoffDate: editForm.cutoff_date || null,
        notes: editForm.notes || null,
      });
      setEditingId(null);
      await reload();
    } catch (caught) {
      setEditError(caught instanceof ApiError ? caught.message : 'Could not save changes to this group block.');
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleCancelBlock(block) {
    try {
      await groupBlocksApi.updateGroupBlock(block.id, { status: 'cancelled' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel this group block.');
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Group Block actions are disabled until connectivity returns.</p>}

      <DataTable
        title="Group blocks"
        state={blocks === null ? 'loading' : blocks.length === 0 ? 'empty' : 'success'}
        emptyMessage="No group blocks yet at this property — add one below."
        columns={[
          { key: 'block_name', label: 'Block' },
          { key: 'company', label: 'Sponsor', render: (row) => companyName(row.company_profile_id) },
          { key: 'dates', label: 'Dates', render: (row) => `${row.start_date} — ${row.end_date}` },
          { key: 'cutoff_date', label: 'Cutoff', render: (row) => row.cutoff_date ?? '—' },
          {
            key: 'status',
            label: 'Status',
            render: (row) => (row.status === 'cancelled' ? <StatusPill tone="neutral" label="Cancelled" /> : <StatusPill tone="success" label="Active" />),
          },
        ]}
        rows={blocks ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <div className={formStyles.actionsRow}>
            <Button size="compact" variant="secondary" onClick={() => onManage?.(row)}>
              Manage
            </Button>
            <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startEdit(row)}>
              Edit
            </Button>
            {row.status !== 'cancelled' && (
              <Button size="compact" variant="danger" disabled={isOffline} onClick={() => handleCancelBlock(row)}>
                Cancel
              </Button>
            )}
          </div>
        )}
      />

      {editingId && (
        <Card title="Edit group block">
          {editError && (
            <p role="alert" className={formStyles.errorBanner}>
              {editError}
            </p>
          )}
          <form className={formStyles.form} onSubmit={handleSaveEdit}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Block name</span>
                <input className={formStyles.input} value={editForm.block_name} onChange={(event) => setEditForm({ ...editForm, block_name: event.target.value })} required />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Sponsor</span>
                <select className={formStyles.select} value={editForm.company_profile_id} onChange={(event) => setEditForm({ ...editForm, company_profile_id: event.target.value })}>
                  <option value="">No sponsor</option>
                  {(companies ?? []).map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Start date</span>
                <input type="date" className={formStyles.input} value={editForm.start_date} onChange={(event) => setEditForm({ ...editForm, start_date: event.target.value })} required />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>End date</span>
                <input type="date" className={formStyles.input} value={editForm.end_date} onChange={(event) => setEditForm({ ...editForm, end_date: event.target.value })} required />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Cutoff date</span>
                <input type="date" className={formStyles.input} value={editForm.cutoff_date} onChange={(event) => setEditForm({ ...editForm, cutoff_date: event.target.value })} />
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

      <Card title="Add a group block">
        {createError && (
          <p role="alert" className={formStyles.errorBanner}>
            {createError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreate}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Block name</span>
              <input className={formStyles.input} value={form.block_name} onChange={(event) => setForm({ ...form, block_name: event.target.value })} placeholder="Acme Conference 2027" required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Sponsor (optional)</span>
              <select className={formStyles.select} value={form.company_profile_id} onChange={(event) => setForm({ ...form, company_profile_id: event.target.value })}>
                <option value="">No sponsor</option>
                {(companies ?? []).map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Start date</span>
              <input type="date" className={formStyles.input} value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>End date</span>
              <input type="date" className={formStyles.input} value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Cutoff date (optional)</span>
              <input type="date" className={formStyles.input} value={form.cutoff_date} onChange={(event) => setForm({ ...form, cutoff_date: event.target.value })} />
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={creating} disabled={isOffline}>
              Add group block
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
