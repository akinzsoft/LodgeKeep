import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';
import { MenuItemsTab } from './MenuItemsTab.jsx';

/**
 * SetupTab — PLAN.md Phase 4's POS core: outlets, terminals. Menu
 * items/categories/inventory moved out into `MenuItemsTab.jsx` (a user-
 * requested consolidation of Setup's own former Menu section with Stock's
 * inventory fields) — this tab now owns exactly the two things every menu
 * item needs to exist under (an outlet, and optionally a terminal for
 * taking payment at it), the same "closely-related simple reference-data
 * lists share one tab" reasoning `ReferenceDataTab`'s own header already
 * used for market segments/booking sources/cancellation policies.
 *
 * Gated on `pos.manage` at the API layer, not here — this tab is always
 * reachable once the POS nav item itself is visible (`pos.operate`), the
 * same "UI-level RBAC is convenience only" rule this codebase's own
 * CLAUDE.md states; a pos_operator submitting a create/edit here gets a
 * real 403 from the backend, same as every other under-permissioned
 * action in this app.
 *
 * Gap closure (found in this session's own broader "REVIEW and test POS"
 * pass): the real backend has always had `PATCH /pos/outlets/:id`/
 * `/terminals/:id` — this tab had create-and-archive only, no way to fix a
 * typo'd name or retype a terminal's device ref. Building this surfaced
 * (and fixed, in `backend/src/modules/pos/controller.js`) a real,
 * previously-uncalled bug in both endpoints: each took `req.body` straight
 * through with no field allowlist. Both edit forms below mirror
 * `StockItemsTab.jsx`'s own edit pattern (`editingId`/`editForm`/
 * `editError`/`editSubmitting`), and each edit is scoped to exactly its
 * own sibling `create*` form's fields — `status` stays reachable only
 * through Archive, matching `RoomTypesTab.jsx`'s own precedent.
 */
export function SetupTab({ activeProperty, isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [terminals, setTerminals] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState(null);

  const [outletForm, setOutletForm] = useState({ code: '', name: '', type: 'bar' });
  const [outletSubmitting, setOutletSubmitting] = useState(false);
  const [outletError, setOutletError] = useState(null);
  const [editingOutletId, setEditingOutletId] = useState(null);
  const [outletEditForm, setOutletEditForm] = useState({ code: '', name: '', type: 'bar' });
  const [outletEditSubmitting, setOutletEditSubmitting] = useState(false);
  const [outletEditError, setOutletEditError] = useState(null);

  const [terminalForm, setTerminalForm] = useState({ device_ref: '', supports_contactless: false });
  const [terminalSubmitting, setTerminalSubmitting] = useState(false);
  const [terminalError, setTerminalError] = useState(null);
  const [editingTerminalId, setEditingTerminalId] = useState(null);
  const [terminalEditForm, setTerminalEditForm] = useState({ device_ref: '', supports_contactless: false });
  const [terminalEditSubmitting, setTerminalEditSubmitting] = useState(false);
  const [terminalEditError, setTerminalEditError] = useState(null);

  async function reload() {
    try {
      setOutlets(await posApi.listOutlets());
    } catch (caught) {
      setOutlets([]);
      setOutletError(caught instanceof ApiError ? caught.message : 'Could not load outlets.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function reloadOutletDetail(outletId) {
    try {
      setTerminals(await posApi.listTerminals(outletId));
    } catch (caught) {
      setTerminals([]);
      setTerminalError(caught instanceof ApiError ? caught.message : 'Could not load this outlet.');
    }
  }

  function handleSelectOutlet(outlet) {
    setSelectedOutletId(outlet.id);
    setTerminals(null);
    setEditingTerminalId(null);
    reloadOutletDetail(outlet.id);
  }

  async function handleCreateOutlet(event) {
    event.preventDefault();
    setOutletSubmitting(true);
    setOutletError(null);
    try {
      await posApi.createOutlet(outletForm);
      setOutletForm({ code: '', name: '', type: 'bar' });
      await reload();
    } catch (caught) {
      setOutletError(caught instanceof ApiError ? caught.message : 'Could not create this outlet.');
    } finally {
      setOutletSubmitting(false);
    }
  }

  async function handleArchiveOutlet(outlet) {
    try {
      await posApi.archiveOutlet(outlet.id);
      if (selectedOutletId === outlet.id) setSelectedOutletId(null);
      await reload();
    } catch (caught) {
      setOutletError(caught instanceof ApiError ? caught.message : 'Could not archive this outlet.');
    }
  }

  function startEditOutlet(outlet) {
    setEditingOutletId(outlet.id);
    setOutletEditError(null);
    setOutletEditForm({ code: outlet.code, name: outlet.name, type: outlet.type });
  }

  async function handleEditOutlet(event) {
    event.preventDefault();
    setOutletEditSubmitting(true);
    setOutletEditError(null);
    try {
      await posApi.updateOutlet(editingOutletId, outletEditForm);
      setEditingOutletId(null);
      await reload();
    } catch (caught) {
      setOutletEditError(caught instanceof ApiError ? caught.message : 'Could not update this outlet.');
    } finally {
      setOutletEditSubmitting(false);
    }
  }

  async function handleCreateTerminal(event) {
    event.preventDefault();
    setTerminalSubmitting(true);
    setTerminalError(null);
    try {
      await posApi.createTerminal({ outletId: selectedOutletId, deviceRef: terminalForm.device_ref, supportsContactless: terminalForm.supports_contactless });
      setTerminalForm({ device_ref: '', supports_contactless: false });
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      setTerminalError(caught instanceof ApiError ? caught.message : 'Could not create this terminal.');
    } finally {
      setTerminalSubmitting(false);
    }
  }

  function startEditTerminal(terminal) {
    setEditingTerminalId(terminal.id);
    setTerminalEditError(null);
    setTerminalEditForm({ device_ref: terminal.device_ref, supports_contactless: !!terminal.supports_contactless });
  }

  async function handleEditTerminal(event) {
    event.preventDefault();
    setTerminalEditSubmitting(true);
    setTerminalEditError(null);
    try {
      await posApi.updateTerminal(editingTerminalId, terminalEditForm);
      setEditingTerminalId(null);
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      setTerminalEditError(caught instanceof ApiError ? caught.message : 'Could not update this terminal.');
    } finally {
      setTerminalEditSubmitting(false);
    }
  }

  const selectedOutlet = outlets?.find((o) => o.id === selectedOutletId);

  return (
    <div className={formStyles.form}>
      <Card title="New outlet">
        {outletError && (
          <p role="alert" className={formStyles.errorBanner}>
            {outletError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreateOutlet}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input className={formStyles.input} value={outletForm.code} onChange={(e) => setOutletForm({ ...outletForm, code: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={outletForm.name} onChange={(e) => setOutletForm({ ...outletForm, name: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Type</span>
              <select className={formStyles.select} value={outletForm.type} onChange={(e) => setOutletForm({ ...outletForm, type: e.target.value })}>
                <option value="bar">Bar</option>
                <option value="restaurant">Restaurant</option>
                <option value="room_service">Room service</option>
                <option value="spa">Spa</option>
                <option value="poolside">Poolside</option>
              </select>
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={outletSubmitting}>
              Add outlet
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Outlets"
        state={outlets === null ? 'loading' : outlets.length === 0 ? 'empty' : 'success'}
        emptyMessage="No outlets yet — add one above."
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type' },
        ]}
        rows={outlets ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <>
            <Button size="compact" variant="ghost" onClick={() => handleSelectOutlet(row)}>
              Manage
            </Button>
            <Button size="compact" variant="ghost" onClick={() => startEditOutlet(row)}>
              Edit
            </Button>
            <Button size="compact" variant="danger" onClick={() => handleArchiveOutlet(row)}>
              Archive
            </Button>
          </>
        )}
      />

      {editingOutletId !== null && (
        <Card title="Edit outlet">
          {outletEditError && (
            <p role="alert" className={formStyles.errorBanner}>
              {outletEditError}
            </p>
          )}
          <form className={formStyles.row} onSubmit={handleEditOutlet}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input className={formStyles.input} value={outletEditForm.code} onChange={(e) => setOutletEditForm({ ...outletEditForm, code: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={outletEditForm.name} onChange={(e) => setOutletEditForm({ ...outletEditForm, name: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Type</span>
              <select className={formStyles.select} value={outletEditForm.type} onChange={(e) => setOutletEditForm({ ...outletEditForm, type: e.target.value })}>
                <option value="bar">Bar</option>
                <option value="restaurant">Restaurant</option>
                <option value="room_service">Room service</option>
                <option value="spa">Spa</option>
                <option value="poolside">Poolside</option>
              </select>
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={outletEditSubmitting}>
                Save changes
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditingOutletId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {selectedOutlet && (
        <>
          <Card title={`Terminals — ${selectedOutlet.name}`}>
            {terminalError && (
              <p role="alert" className={formStyles.errorBanner}>
                {terminalError}
              </p>
            )}
            <form className={formStyles.row} onSubmit={handleCreateTerminal}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Device ref</span>
                <input
                  className={formStyles.input}
                  value={terminalForm.device_ref}
                  onChange={(e) => setTerminalForm({ ...terminalForm, device_ref: e.target.value })}
                  required
                />
              </label>
              <label className={formStyles.checkboxField}>
                <input
                  className={formStyles.checkbox}
                  type="checkbox"
                  checked={terminalForm.supports_contactless}
                  onChange={(e) => setTerminalForm({ ...terminalForm, supports_contactless: e.target.checked })}
                />
                <span className={formStyles.label}>Supports contactless</span>
              </label>
              <div className={formStyles.actionsRow}>
                <Button type="submit" loading={terminalSubmitting}>
                  Add terminal
                </Button>
              </div>
            </form>
            <DataTable
              state={terminals === null ? 'loading' : terminals.length === 0 ? 'empty' : 'success'}
              emptyMessage="No terminals yet."
              columns={[
                { key: 'device_ref', label: 'Device ref' },
                { key: 'supports_contactless', label: 'Contactless', render: (row) => (row.supports_contactless ? 'Yes' : 'No') },
              ]}
              rows={terminals ?? []}
              rowKey={(row) => row.id}
              actions={(row) => (
                <>
                  <Button size="compact" variant="ghost" onClick={() => startEditTerminal(row)}>
                    Edit
                  </Button>
                  <Button size="compact" variant="danger" onClick={() => posApi.archiveTerminal(row.id).then(() => reloadOutletDetail(selectedOutletId))}>
                    Archive
                  </Button>
                </>
              )}
            />

          </Card>

          {editingTerminalId !== null && (
            <Card title="Edit terminal">
              {terminalEditError && (
                <p role="alert" className={formStyles.errorBanner}>
                  {terminalEditError}
                </p>
              )}
              <form className={formStyles.row} onSubmit={handleEditTerminal}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Device ref</span>
                  <input
                    className={formStyles.input}
                    value={terminalEditForm.device_ref}
                    onChange={(e) => setTerminalEditForm({ ...terminalEditForm, device_ref: e.target.value })}
                    required
                  />
                </label>
                <label className={formStyles.checkboxField}>
                  <input
                    className={formStyles.checkbox}
                    type="checkbox"
                    checked={terminalEditForm.supports_contactless}
                    onChange={(e) => setTerminalEditForm({ ...terminalEditForm, supports_contactless: e.target.checked })}
                  />
                  <span className={formStyles.label}>Supports contactless</span>
                </label>
                <div className={formStyles.actionsRow}>
                  <Button type="submit" loading={terminalEditSubmitting}>
                    Save changes
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setEditingTerminalId(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}

          <MenuItemsTab activeProperty={activeProperty} outletId={selectedOutlet.id} outletName={selectedOutlet.name} isOffline={isOffline} />
        </>
      )}
    </div>
  );
}
