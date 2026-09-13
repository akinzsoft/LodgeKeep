import { useEffect, useState } from 'react';
import { Card, DataTable, Button, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

const EMPTY_FORM = { outlet_id: '', name: '', unit: '', purchase_cost: '', supplier: '', reorder_level: '' };

/**
 * StockItemsTab — PLAN.md Phase 6's "POS inventory & stock control"
 * (PRODUCT_REQUIREMENTS.md §3.4). The raw ingredient/consumable catalogue:
 * list (with a "Low stock only" filter), create, edit, and archive.
 *
 * `pos.stock_view` sees this list read-only; `pos.stock_manage` is what the
 * backend actually requires for create/update/archive (`stock/routes.js`).
 * No client-side permission check hides the create/edit/archive controls
 * here — the same "always reachable, the real 403 is what a lower-tier
 * account sees" convention `SetupTab.jsx`/`QrTokensTab.jsx` already
 * establish for this exact screen; this app has no endpoint yet that would
 * even let a tab know which of the two keys the signed-in user actually
 * holds.
 *
 * `purchase_cost` is deliberately NOT an editable field on the edit form —
 * it's server-managed, wholesale-replaced only by a real goods-received
 * delivery (`stock/service.js`'s own "last-cost only" rule) — shown
 * read-only instead, so editing here can never silently disagree with the
 * real cost basis a delivery just set.
 *
 * Bug fix (see `POSScreen`'s own header): the cost column used to hardcode
 * a literal NGN currency code — `stock_items` carries no currency column of
 * its own, so the real source of truth is the active property's
 * `base_currency`, now threaded in as a prop.
 */
export function StockItemsTab({ activeProperty, isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [items, setItems] = useState(null);
  const [outletFilter, setOutletFilter] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [error, setError] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', unit: '', supplier: '', reorder_level: '' });
  const [editError, setEditError] = useState(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [archiving, setArchiving] = useState(null);

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
  }, []);

  async function reloadItems() {
    try {
      setItems(await stockApi.listStockItems({ outletId: outletFilter || undefined, lowStockOnly }));
      setError(null);
    } catch (caught) {
      setItems([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load stock items.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount/filter-change; no data-fetching library exists yet to own this
    reloadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- outletFilter/lowStockOnly drive this refetch directly
  }, [outletFilter, lowStockOnly]);

  async function handleCreate(event) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await stockApi.createStockItem({
        outletId: form.outlet_id,
        name: form.name,
        unit: form.unit,
        purchaseCost: form.purchase_cost || undefined,
        supplier: form.supplier || undefined,
        reorderLevel: form.reorder_level || undefined,
      });
      setForm({ ...EMPTY_FORM, outlet_id: form.outlet_id });
      await reloadItems();
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not create this stock item.');
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(item) {
    setEditingId(item.id);
    setEditError(null);
    setEditForm({ name: item.name, unit: item.unit, supplier: item.supplier ?? '', reorder_level: item.reorder_level });
  }

  async function handleEditSubmit(event) {
    event.preventDefault();
    setEditSubmitting(true);
    setEditError(null);
    try {
      await stockApi.updateStockItem(editingId, {
        name: editForm.name,
        unit: editForm.unit,
        supplier: editForm.supplier || null,
        reorderLevel: editForm.reorder_level,
      });
      setEditingId(null);
      await reloadItems();
    } catch (caught) {
      setEditError(caught instanceof ApiError ? caught.message : 'Could not update this stock item.');
    } finally {
      setEditSubmitting(false);
    }
  }

  const editingItem = (items ?? []).find((item) => item.id === editingId);

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Stock items cannot be added, edited, or archived until connectivity returns.</p>}

      {/* Outside DataTable's own toolbar slot, deliberately — Card only
          renders `children` (toolbar included) while `state === 'success'`,
          the same gap this codebase's own reporting/POS review passes
          already found and fixed elsewhere (`GuestOrdersTab.jsx`'s own
          comment). "Low stock only" routinely shows zero rows by design —
          a filter control should never vanish because of that. */}
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Filter by outlet</span>
          <select className={formStyles.select} value={outletFilter} onChange={(event) => setOutletFilter(event.target.value)}>
            <option value="">All outlets</option>
            {(outlets ?? []).map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </select>
        </label>
        <label className={formStyles.checkboxField}>
          <input className={formStyles.checkbox} type="checkbox" checked={lowStockOnly} onChange={(event) => setLowStockOnly(event.target.checked)} />
          <span className={formStyles.label}>Low stock only</span>
        </label>
      </div>

      <Card title="New stock item">
        {formError && (
          <p role="alert" className={formStyles.errorBanner}>
            {formError}
          </p>
        )}
        <form className={formStyles.row} onSubmit={handleCreate}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Outlet</span>
            <select className={formStyles.select} value={form.outlet_id} onChange={(e) => setForm({ ...form, outlet_id: e.target.value })} required disabled={isOffline}>
              <option value="" disabled>
                Select an outlet
              </option>
              {(outlets ?? []).map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </option>
              ))}
            </select>
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Name</span>
            <input className={formStyles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required disabled={isOffline} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Unit</span>
            <input className={formStyles.input} placeholder="ml, bottle, kg…" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} required disabled={isOffline} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Initial cost (optional)</span>
            <input
              className={formStyles.input}
              type="number"
              step="0.01"
              min="0"
              value={form.purchase_cost}
              onChange={(e) => setForm({ ...form, purchase_cost: e.target.value })}
              disabled={isOffline}
            />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Supplier (optional)</span>
            <input className={formStyles.input} value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} disabled={isOffline} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Reorder level (optional)</span>
            <input
              className={formStyles.input}
              type="number"
              step="0.001"
              min="0"
              value={form.reorder_level}
              onChange={(e) => setForm({ ...form, reorder_level: e.target.value })}
              disabled={isOffline}
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              Add stock item
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Stock items"
        state={items === null ? 'loading' : items.length === 0 ? 'empty' : 'success'}
        emptyMessage="No stock items match this filter."
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'unit', label: 'Unit' },
          { key: 'current_quantity', label: 'On hand', align: 'right', render: (row) => formatQuantity(row.current_quantity, row.unit) },
          { key: 'reorder_level', label: 'Reorder level', align: 'right', render: (row) => formatQuantity(row.reorder_level, row.unit) },
          { key: 'purchase_cost', label: 'Cost', align: 'right', render: (row) => <Money amount={row.purchase_cost} currencyCode={activeProperty.base_currency} /> },
          { key: 'supplier', label: 'Supplier', render: (row) => row.supplier ?? '—' },
        ]}
        rows={items ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <>
            <Button size="compact" variant="ghost" disabled={isOffline} onClick={() => startEdit(row)}>
              Edit
            </Button>
            <Button size="compact" variant="danger" disabled={isOffline} onClick={() => setArchiving(row)}>
              Archive
            </Button>
          </>
        )}
      />

      {editingItem && (
        <Card title={`Edit — ${editingItem.name}`}>
          {editError && (
            <p role="alert" className={formStyles.errorBanner}>
              {editError}
            </p>
          )}
          <p className={formStyles.hint}>
            Cost is <Money amount={editingItem.purchase_cost} currencyCode={activeProperty.base_currency} /> — set automatically by the most recent goods-received delivery, not editable here.
          </p>
          <form className={formStyles.row} onSubmit={handleEditSubmit}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required disabled={isOffline} />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Unit</span>
              <input className={formStyles.input} value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })} required disabled={isOffline} />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Supplier</span>
              <input className={formStyles.input} value={editForm.supplier} onChange={(e) => setEditForm({ ...editForm, supplier: e.target.value })} disabled={isOffline} />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Reorder level</span>
              <input
                className={formStyles.input}
                type="number"
                step="0.001"
                min="0"
                value={editForm.reorder_level}
                onChange={(e) => setEditForm({ ...editForm, reorder_level: e.target.value })}
                disabled={isOffline}
              />
            </label>
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

      {archiving && (
        <ConfirmDialog
          title="Archive this stock item?"
          consequence={`This archives "${archiving.name}". It stops appearing in lists and pickers; its own past movement history is unaffected.`}
          confirmLabel="Archive"
          onConfirm={async () => {
            setArchiving(null);
            try {
              await stockApi.archiveStockItem(archiving.id);
              await reloadItems();
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not archive this stock item.');
            }
          }}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
