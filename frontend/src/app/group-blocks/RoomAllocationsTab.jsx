import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { groupBlocksApi, setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './GBForm.module.css';

const EMPTY_FORM = { room_type_id: '', mode: 'single', stay_date: '', start_date: '', end_date: '', rooms_blocked: '' };

/**
 * RoomAllocationsTab — PLAN.md Phase 4 (Group Blocks). Requires a selected
 * block (`GroupBlocksScreen`'s own "select once, act across tabs" state) —
 * an honest empty-state prompt otherwise, matching `CashieringScreen`'s own
 * no-folio-yet state. The single-date/range toggle reuses the exact
 * interaction `RoomsTab`'s own bulk room-add form already established for
 * range-based bulk entry.
 */
export function RoomAllocationsTab({ isOffline = false, block }) {
  const [allocations, setAllocations] = useState(null);
  const [roomTypes, setRoomTypes] = useState(null);
  const [error, setError] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  async function reload() {
    if (!block) return;
    setError(null);
    try {
      const [allocationRows, roomTypeRows] = await Promise.all([groupBlocksApi.listRoomAllocations(block.id), setupApi.listRoomTypes()]);
      setAllocations(allocationRows);
      setRoomTypes(roomTypeRows);
    } catch (caught) {
      setAllocations([]);
      setRoomTypes([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load room allocations.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount/block-change; no data-fetching library exists yet to own this
    reload();
  }, [block?.id]);

  function roomTypeName(roomTypeId) {
    return (roomTypes ?? []).find((rt) => String(rt.id) === String(roomTypeId))?.name ?? `Room type ${roomTypeId}`;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await groupBlocksApi.upsertRoomAllocation(block.id, {
        roomTypeId: form.room_type_id,
        stayDate: form.mode === 'single' ? form.stay_date : undefined,
        startDate: form.mode === 'range' ? form.start_date : undefined,
        endDate: form.mode === 'range' ? form.end_date : undefined,
        roomsBlocked: Number(form.rooms_blocked),
      });
      setForm(EMPTY_FORM);
      await reload();
    } catch (caught) {
      setSubmitError(caught instanceof ApiError ? caught.message : 'Could not set this room allocation.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!block) {
    return <p className={formStyles.hint}>Select a block from the Blocks tab (its &quot;Manage&quot; action) to configure room allocations.</p>;
  }

  return (
    <div>
      <p className={formStyles.hint}>
        Room allocations for <strong>{block.block_name}</strong>.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Room allocation changes are disabled until connectivity returns.</p>}

      <DataTable
        title="Room allocations"
        state={allocations === null ? 'loading' : allocations.length === 0 ? 'empty' : 'success'}
        emptyMessage="No room allocations set yet for this block — add one below."
        columns={[
          { key: 'room_type', label: 'Room type', render: (row) => row.room_type_name ?? roomTypeName(row.room_type_id) },
          { key: 'stay_date', label: 'Night' },
          { key: 'rooms_blocked', label: 'Rooms blocked', align: 'right' },
        ]}
        rows={allocations ?? []}
        rowKey={(row) => row.id}
      />

      <Card title="Set a room allocation">
        {submitError && (
          <p role="alert" className={formStyles.errorBanner}>
            {submitError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Room type</span>
              <select className={formStyles.select} value={form.room_type_id} onChange={(event) => setForm({ ...form, room_type_id: event.target.value })} required>
                <option value="" disabled>
                  Select a room type
                </option>
                {(roomTypes ?? []).map((roomType) => (
                  <option key={roomType.id} value={roomType.id}>
                    {roomType.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Rooms blocked</span>
              <input
                type="number"
                min="0"
                className={formStyles.input}
                value={form.rooms_blocked}
                onChange={(event) => setForm({ ...form, rooms_blocked: event.target.value })}
                required
              />
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Applies to</span>
              <select className={formStyles.select} value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
                <option value="single">A single night</option>
                <option value="range">A range of nights</option>
              </select>
            </label>
            {form.mode === 'single' ? (
              <label className={formStyles.field}>
                <span className={formStyles.label}>Night</span>
                <input type="date" className={formStyles.input} value={form.stay_date} onChange={(event) => setForm({ ...form, stay_date: event.target.value })} required />
              </label>
            ) : (
              <>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>From</span>
                  <input type="date" className={formStyles.input} value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} required />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>To (exclusive, like a checkout date)</span>
                  <input type="date" className={formStyles.input} value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} required />
                </label>
              </>
            )}
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              Set allocation
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
