import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

const OCCUPANCY_TONE = { vacant: 'success', occupied: 'info' };
const OCCUPANCY_LABEL = { vacant: 'Available', occupied: 'Occupied' };
const HOUSEKEEPING_TONE = { clean: 'success', dirty: 'warning' };
const HOUSEKEEPING_LABEL = { clean: 'Clean', dirty: 'Dirty' };

/**
 * RoomsTab — PRODUCT_REQUIREMENTS.md's "Room inventory — table of physical
 * rooms with inline edit, plus bulk add (room number range + floor + type)
 * and CSV import." Bulk add is real (`POST /rooms/bulk`); CSV import is
 * deliberately out of scope for this pass (this session's confirmed
 * decision) — it overlaps with the separate, fully-specified Data
 * Migration module (§3.20, Phase 5), and building a parallel one-off parser
 * now would duplicate that work rather than reuse it. Inline edit is also
 * not built — the room list here is read-only plus bulk-create.
 *
 * Gap closure (user-reported): "click on any roomtype it shld bring all
 * rooms associated to that room type with status if available, dirty" —
 * `filterRoomTypeId`/`onClearFilter` (both optional; `RoomsScreen` supplies
 * them, `SetupScreen`'s own unrelated usage of this tab doesn't) narrow the
 * list to one type. The old "Status" column showed `rooms.status`
 * (active/archived) — always "active" here, since an archived room is
 * already excluded server-side (`listRooms`'s own `whereNot`), so every row
 * showed the identical, uninformative value. Replaced with the two real
 * signals the request actually asked for: occupancy (`front_desk_status`)
 * and cleanliness (`housekeeping_reported_status`) — both already returned
 * by `GET /rooms`, just never rendered — each a real `StatusPill`, per
 * DESIGN_SYSTEM.md §1's "status is always a filled pill, never colour
 * alone" rule.
 */
export function RoomsTab({ disabled, filterRoomTypeId, onClearFilter }) {
  const [rooms, setRooms] = useState(null);
  const [roomTypes, setRoomTypes] = useState([]);
  const [form, setForm] = useState({ room_type_id: '', floor: '', from: '', to: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [createdCount, setCreatedCount] = useState(null);

  async function reload() {
    try {
      const [roomsResult, roomTypesResult] = await Promise.all([setupApi.listRooms(), setupApi.listRoomTypes()]);
      setRooms(roomsResult);
      setRoomTypes(roomTypesResult);
    } catch (caught) {
      // Stops the table showing a loading skeleton forever — the visible
      // error banner below is what actually explains what happened.
      setRooms([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load rooms.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — rooms belong to one property.</p>;
  }

  const roomTypeName = (id) => roomTypes.find((rt) => String(rt.id) === String(id))?.name ?? id;
  const filteredRooms =
    filterRoomTypeId != null ? (rooms ?? []).filter((room) => String(room.room_type_id) === String(filterRoomTypeId)) : rooms;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setCreatedCount(null);
    try {
      const created = await setupApi.bulkCreateRooms({
        room_type_id: form.room_type_id,
        floor: form.floor || undefined,
        from: form.from,
        to: form.to,
      });
      setCreatedCount(created.length);
      setForm({ room_type_id: form.room_type_id, floor: form.floor, from: '', to: '' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create rooms.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      {filterRoomTypeId != null && (
        <p className={formStyles.disabledNotice}>
          Showing rooms for <strong>{roomTypeName(filterRoomTypeId)}</strong> only.{' '}
          <Button size="compact" variant="ghost" onClick={onClearFilter}>
            Clear filter
          </Button>
        </p>
      )}

      <DataTable
        title="Rooms"
        state={rooms === null ? 'loading' : filteredRooms.length === 0 ? 'empty' : 'success'}
        emptyMessage={
          filterRoomTypeId != null
            ? 'No rooms of this type yet — bulk-add some below.'
            : 'No rooms yet — bulk-add a range below rather than hand-keying them one at a time.'
        }
        columns={[
          { key: 'room_number', label: 'Room' },
          { key: 'floor', label: 'Floor', render: (row) => row.floor ?? '—' },
          { key: 'room_type_id', label: 'Type', render: (row) => roomTypeName(row.room_type_id) },
          {
            key: 'front_desk_status',
            label: 'Occupancy',
            render: (row) => (
              <StatusPill
                tone={OCCUPANCY_TONE[row.front_desk_status] ?? 'neutral'}
                label={OCCUPANCY_LABEL[row.front_desk_status] ?? row.front_desk_status ?? '—'}
              />
            ),
          },
          {
            key: 'housekeeping_reported_status',
            label: 'Housekeeping',
            render: (row) => (
              <StatusPill
                tone={HOUSEKEEPING_TONE[row.housekeeping_reported_status] ?? 'neutral'}
                label={HOUSEKEEPING_LABEL[row.housekeeping_reported_status] ?? row.housekeeping_reported_status ?? '—'}
              />
            ),
          },
        ]}
        rows={filteredRooms ?? []}
        rowKey={(row) => row.id}
      />

      <Card title="Bulk-add rooms">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        {createdCount !== null && !error && (
          <p className={formStyles.disabledNotice} role="status">
            Created {createdCount} room{createdCount === 1 ? '' : 's'}.
          </p>
        )}
        {roomTypes.length === 0 ? (
          <p className={formStyles.disabledNotice}>Add a room type first — every room needs one.</p>
        ) : (
          <form className={formStyles.form} onSubmit={handleSubmit}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Room type</span>
                <select
                  className={formStyles.select}
                  value={form.room_type_id}
                  onChange={(event) => setForm({ ...form, room_type_id: event.target.value })}
                  required
                >
                  <option value="" disabled>
                    Select a room type
                  </option>
                  {roomTypes.map((rt) => (
                    <option key={rt.id} value={rt.id}>
                      {rt.name} ({rt.code})
                    </option>
                  ))}
                </select>
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Floor</span>
                <input
                  className={formStyles.input}
                  value={form.floor}
                  onChange={(event) => setForm({ ...form, floor: event.target.value })}
                  placeholder="2"
                />
              </label>
            </div>

            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>From</span>
                <input
                  className={formStyles.input}
                  value={form.from}
                  onChange={(event) => setForm({ ...form, from: event.target.value })}
                  placeholder="201"
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>To</span>
                <input
                  className={formStyles.input}
                  value={form.to}
                  onChange={(event) => setForm({ ...form, to: event.target.value })}
                  placeholder="260"
                  required
                />
              </label>
            </div>

            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={submitting}>
                Create rooms
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
