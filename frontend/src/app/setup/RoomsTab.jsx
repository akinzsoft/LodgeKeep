import { useEffect, useRef, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import { BlockedRoomsPanel, summariseReservations, plural } from './RoomManagementParts.jsx';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';
import roomStyles from './RoomsTab.module.css';

const OCCUPANCY_TONE = { vacant: 'success', occupied: 'info' };
const OCCUPANCY_LABEL = { vacant: 'Available', occupied: 'Occupied' };
const HOUSEKEEPING_TONE = { clean: 'success', dirty: 'warning' };
const HOUSEKEEPING_LABEL = { clean: 'Clean', dirty: 'Dirty' };

const BLOCKED_CODE = 'CONFLICT_ROOM_CHANGE_BLOCKED';

/**
 * RoomsTab — PRODUCT_REQUIREMENTS.md's "Room inventory — table of physical
 * rooms with inline edit, plus bulk add (room number range + floor + type)
 * and CSV import." Bulk add is real (`POST /rooms/bulk`); CSV import is
 * deliberately out of scope (this session's confirmed decision) — it
 * overlaps with the separate, fully-specified Data Migration module (§3.20,
 * Phase 5), and building a parallel one-off parser would duplicate that work.
 *
 * Gap closure (user-reported): "click on any roomtype it shld bring all
 * rooms associated to that room type with status if available, dirty" —
 * `filterRoomTypeId`/`onClearFilter` (both optional; `RoomsScreen` supplies
 * them, `SetupScreen`'s own unrelated usage of this tab doesn't) narrow the
 * list to one type. Each row shows occupancy (`front_desk_status`) and
 * cleanliness (`housekeeping_reported_status`) as real `StatusPill`s.
 *
 * Gap closure (room management): rooms can now be managed AFTER creation —
 * rename/floor, change room type (single or bulk), archive (single or bulk),
 * restore, and delete a room nothing references. The rules live in the
 * backend (`setup/room-management.js`); this screen only asks and reports:
 *   - a change the server refuses is ALL-OR-NOTHING — `BlockedRoomsPanel`
 *     lists every blocked room with the server's own sentence, the selection
 *     is kept so the blocked rooms can be deselected and the rest retried;
 *   - Remove asks the server first (`getRoomUsage`) whether the room has
 *     history, and says so plainly: a room with history can only be archived,
 *     never deleted (folios and stays must survive);
 *   - the bulk toolbar sits OUTSIDE `DataTable`, because `DataTable`'s
 *     `toolbar` only renders in its success state and would vanish exactly
 *     when a filter leaves zero rows;
 *   - `isOffline` disables every change and says why — nothing is queued.
 *
 * @param {object} props
 * @param {boolean} props.disabled
 * @param {string|number|null} [props.filterRoomTypeId]
 * @param {() => void} [props.onClearFilter]
 * @param {(roomTypeId: string|number) => void} [props.onFilterRoomType]  Lets the "View rooms" link after a move narrow the list to the destination type.
 * @param {boolean} [props.isOffline]
 */
export function RoomsTab({ disabled, filterRoomTypeId, onClearFilter, onFilterRoomType, isOffline = false }) {
  const [rooms, setRooms] = useState(null);
  const [roomTypes, setRoomTypes] = useState([]);
  const [view, setView] = useState('active'); // 'active' | 'archived'
  const [form, setForm] = useState({ room_type_id: '', floor: '', from: '', to: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { text, showTypeId? }
  const [blocked, setBlocked] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ room_number: '', floor: '' });
  // { kind: 'change-type'|'archive'|'remove', roomIds?, room?, usage? }
  const [dialog, setDialog] = useState(null);
  const [targetTypeId, setTargetTypeId] = useState('');
  const [changeReason, setChangeReason] = useState('');

  // Bumped on every load; a response from an older load (e.g. the working list
  // still in flight when "Show archived rooms" was toggled) is dropped, so it
  // can never overwrite the list the user is now looking at.
  const loadSequence = useRef(0);

  async function reload() {
    loadSequence.current += 1;
    const thisLoad = loadSequence.current;
    try {
      const [roomsResult, roomTypesResult] = await Promise.all([
        setupApi.listRooms(view === 'archived' ? { status: 'archived' } : {}),
        setupApi.listRoomTypes(),
      ]);
      if (thisLoad !== loadSequence.current) return;
      setRooms(roomsResult);
      setRoomTypes(roomTypesResult);
      // A room that left the list (archived, deleted, restored) can no longer be selected.
      setSelected((current) => new Set([...current].filter((id) => roomsResult.some((room) => String(room.id) === String(id)))));
    } catch (caught) {
      if (thisLoad !== loadSequence.current) return;
      // Stops the table showing a loading skeleton forever — the visible
      // error banner below is what actually explains what happened.
      setRooms([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load rooms.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload closes over `view`, which is the dependency
  }, [disabled, view]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — rooms belong to one property.</p>;
  }

  const roomTypeName = (id) => roomTypes.find((rt) => String(rt.id) === String(id))?.name ?? 'Archived type';
  const visibleRooms =
    filterRoomTypeId != null ? (rooms ?? []).filter((room) => String(room.room_type_id) === String(filterRoomTypeId)) : (rooms ?? []);
  const allShownSelected = visibleRooms.length > 0 && visibleRooms.every((room) => selected.has(String(room.id)));
  const archivedView = view === 'archived';

  function clearMessages() {
    setError(null);
    setNotice(null);
    setBlocked(null);
  }

  function toggleRoom(id) {
    setSelected((current) => {
      const next = new Set(current);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllShown() {
    setSelected(allShownSelected ? new Set() : new Set(visibleRooms.map((room) => String(room.id))));
  }

  /** Runs one change; a guard refusal becomes the blocked panel, anything else an error banner. */
  async function runChange(action, fallbackMessage) {
    setSubmitting(true);
    clearMessages();
    try {
      return await action();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === BLOCKED_CODE && Array.isArray(caught.details?.blocked)) {
        setBlocked(caught.details.blocked);
      } else {
        setError(caught instanceof ApiError ? caught.message : fallbackMessage);
      }
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  function clearedSentence(result) {
    const parts = [];
    if (result.cleared_preferences?.length > 0) {
      parts.push(
        `Cleared the room preference on ${plural(result.cleared_preferences.length, 'reservation')} (${summariseReservations(result.cleared_preferences)}) — the bookings themselves are unchanged.`
      );
    }
    if (result.cleared_connecting_links?.length > 0) {
      parts.push(`Removed the connecting-room link on ${result.cleared_connecting_links.map((link) => link.room_number).join(', ')}.`);
    }
    return parts.join(' ');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const created = await runChange(
      () =>
        setupApi.bulkCreateRooms({
          room_type_id: form.room_type_id,
          floor: form.floor || undefined,
          from: form.from,
          to: form.to,
        }),
      'Could not create rooms.'
    );
    if (!created) return;
    setNotice({ text: `Created ${plural(created.length, 'room')}.` });
    setForm({ room_type_id: form.room_type_id, floor: form.floor, from: '', to: '' });
    await reload();
  }

  function startEdit(room) {
    clearMessages();
    setEditingId(room.id);
    setEditForm({ room_number: room.room_number, floor: room.floor ?? '' });
  }

  async function handleEditSubmit(event) {
    event.preventDefault();
    const updated = await runChange(
      () => setupApi.updateRoom(editingId, { room_number: editForm.room_number, floor: editForm.floor.trim() === '' ? null : editForm.floor }),
      'Could not update the room.'
    );
    if (!updated) return;
    setNotice({ text: `Saved room ${updated.room_number}.` });
    setEditingId(null);
    await reload();
  }

  function openChangeType(roomIds) {
    clearMessages();
    setTargetTypeId('');
    setChangeReason('');
    setDialog({ kind: 'change-type', roomIds: roomIds.map(String) });
  }

  async function confirmChangeType() {
    const { roomIds } = dialog;
    const result = await runChange(
      () => setupApi.bulkChangeRoomType({ room_ids: roomIds, room_type_id: targetTypeId, reason: changeReason.trim() || undefined }),
      'Could not change the room type.'
    );
    setDialog(null);
    if (!result) return;
    const typeName = roomTypeName(targetTypeId);
    const sentences = [];
    if (result.changed.length > 0) sentences.push(`Moved ${plural(result.changed.length, 'room')} to ${typeName}.`);
    if (result.unchanged.length > 0) sentences.push(`${plural(result.unchanged.length, 'room')} already in ${typeName}.`);
    const cleared = clearedSentence(result);
    if (cleared) sentences.push(cleared);
    setNotice({ text: sentences.join(' '), showTypeId: result.changed.length > 0 ? targetTypeId : null });
    setSelected(new Set());
    await reload();
  }

  function openArchive(roomIds) {
    clearMessages();
    setDialog({ kind: 'archive', roomIds: roomIds.map(String) });
  }

  /** `roomIds` defaults to the dialog's own rooms; the Remove dialog's "Archive instead" passes its one room explicitly. */
  async function confirmArchive(reason, roomIds = dialog.roomIds) {
    const result = await runChange(() => setupApi.bulkArchiveRooms({ room_ids: roomIds, reason }), 'Could not archive the rooms.');
    setDialog(null);
    if (!result) return;
    const sentences = [`Archived ${plural(result.changed.length, 'room')}.`];
    if (result.unchanged.length > 0) sentences.push(`${plural(result.unchanged.length, 'room')} already archived.`);
    const cleared = clearedSentence(result);
    if (cleared) sentences.push(cleared);
    setNotice({ text: sentences.join(' ') });
    setSelected(new Set());
    await reload();
  }

  /** Asks the server whether the room has history BEFORE the user commits to a reason, so the dialog can say which of delete / archive applies. */
  async function openRemove(room) {
    clearMessages();
    setSubmitting(true);
    try {
      const usage = await setupApi.getRoomUsage(room.id);
      setDialog({ kind: 'remove', room, usage });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not check the room.');
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmRemove(reason) {
    const { room } = dialog;
    const result = await runChange(() => setupApi.deleteRoom(room.id, reason), 'Could not delete the room.');
    setDialog(null);
    if (!result) return;
    setNotice({ text: `Deleted room ${room.room_number}. Its number can be used again.` });
    await reload();
  }

  async function restore(room) {
    const result = await runChange(() => setupApi.restoreRoom(room.id), 'Could not restore the room.');
    if (!result) return;
    setNotice({ text: `Restored room ${room.room_number}.` });
    await reload();
  }

  const actionsDisabled = isOffline || submitting;

  function describeUsage(usage) {
    const parts = Object.entries(usage.references).map(([table, count]) => `${count} in ${table.replace(/_/g, ' ')}`);
    return usage.occupied ? `a guest is in it right now${parts.length ? `, and it has history (${parts.join(', ')})` : ''}` : `it has history (${parts.join(', ')})`;
  }

  return (
    <div className={styles.page}>
      {isOffline && <p className={formStyles.disabledNotice}>You&apos;re offline — room changes are disabled until the connection returns.</p>}

      {filterRoomTypeId != null && (
        <p className={formStyles.disabledNotice}>
          Showing rooms for <strong>{roomTypeName(filterRoomTypeId)}</strong> only.{' '}
          <Button size="compact" variant="ghost" onClick={onClearFilter}>
            Clear filter
          </Button>
        </p>
      )}

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {blocked && <BlockedRoomsPanel blocked={blocked} onDismiss={() => setBlocked(null)} />}
      {notice && (
        <div className={roomStyles.noticeRow}>
          <p className={formStyles.disabledNotice} role="status">
            {notice.text}
          </p>
          {notice.showTypeId != null && onFilterRoomType && (
            <Button size="compact" variant="secondary" onClick={() => onFilterRoomType(notice.showTypeId)}>
              View {roomTypeName(notice.showTypeId)} rooms
            </Button>
          )}
        </div>
      )}

      <div className={roomStyles.bulkBar}>
        {!archivedView && (
          <label className={formStyles.checkboxField}>
            <input
              type="checkbox"
              className={formStyles.checkbox}
              checked={allShownSelected}
              disabled={visibleRooms.length === 0}
              onChange={toggleAllShown}
              aria-label="Select all shown rooms"
            />
            <span>Select all shown ({visibleRooms.length})</span>
          </label>
        )}
        {!archivedView && selected.size > 0 && (
          <>
            <span className={roomStyles.bulkCount}>{selected.size} selected</span>
            <Button size="compact" variant="secondary" disabled={actionsDisabled} onClick={() => openChangeType([...selected])}>
              Change type
            </Button>
            <Button size="compact" variant="secondary" disabled={actionsDisabled} onClick={() => openArchive([...selected])}>
              Archive
            </Button>
            <Button size="compact" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </>
        )}
        <span className={roomStyles.spacer} />
        <Button
          size="compact"
          variant="ghost"
          onClick={() => {
            clearMessages();
            setSelected(new Set());
            setRooms(null);
            setView(archivedView ? 'active' : 'archived');
          }}
        >
          {archivedView ? 'Back to rooms' : 'Show archived rooms'}
        </Button>
      </div>

      <DataTable
        title={archivedView ? 'Archived rooms' : 'Rooms'}
        state={rooms === null ? 'loading' : visibleRooms.length === 0 ? 'empty' : 'success'}
        emptyMessage={
          archivedView
            ? 'No archived rooms.'
            : filterRoomTypeId != null
              ? 'No rooms of this type yet — bulk-add some below.'
              : 'No rooms yet — bulk-add a range below rather than hand-keying them one at a time.'
        }
        columns={[
          {
            key: 'room_number',
            label: 'Room',
            render: (row) =>
              archivedView ? (
                row.room_number
              ) : (
                <label className={roomStyles.roomCell}>
                  <input
                    type="checkbox"
                    className={formStyles.checkbox}
                    checked={selected.has(String(row.id))}
                    onChange={() => toggleRoom(row.id)}
                    aria-label={`Select room ${row.room_number}`}
                  />
                  {row.room_number}
                </label>
              ),
          },
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
        rows={visibleRooms}
        rowKey={(row) => row.id}
        actions={(row) =>
          archivedView ? (
            <Button size="compact" variant="secondary" disabled={actionsDisabled} onClick={() => restore(row)}>
              Restore
            </Button>
          ) : (
            <div className={roomStyles.rowActions}>
              <Button size="compact" variant="secondary" disabled={actionsDisabled} onClick={() => startEdit(row)}>
                Edit
              </Button>
              <Button size="compact" variant="secondary" disabled={actionsDisabled} onClick={() => openChangeType([row.id])}>
                Change type
              </Button>
              <Button size="compact" variant="secondary" disabled={actionsDisabled} onClick={() => openArchive([row.id])}>
                Archive
              </Button>
              <Button size="compact" variant="secondary" disabled={actionsDisabled} onClick={() => openRemove(row)}>
                Remove
              </Button>
            </div>
          )
        }
      />

      {editingId && (
        <Card title="Edit room">
          <p className={formStyles.disabledNotice}>
            Renaming updates every screen that shows this room. If your door-lock software labels this room by number, update its label
            too — the next door-access import matches rooms by their current number.
          </p>
          <form className={formStyles.form} onSubmit={handleEditSubmit}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Room number</span>
                <input
                  className={formStyles.input}
                  value={editForm.room_number}
                  maxLength={20}
                  onChange={(event) => setEditForm({ ...editForm, room_number: event.target.value })}
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Floor</span>
                <input
                  className={formStyles.input}
                  value={editForm.floor}
                  maxLength={20}
                  onChange={(event) => setEditForm({ ...editForm, floor: event.target.value })}
                />
              </label>
            </div>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={submitting} disabled={isOffline}>
                Save room
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Bulk-add rooms">
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
              <Button type="submit" loading={submitting} disabled={isOffline}>
                Create rooms
              </Button>
            </div>
          </form>
        )}
      </Card>

      {dialog?.kind === 'change-type' && (
        <ConfirmDialog
          title={`Change room type for ${plural(dialog.roomIds.length, 'room')}`}
          consequence="The rooms join the new type immediately. Reservations that requested one of these rooms keep their booking but lose that room preference. A room with a guest in it, or one whose type has nights already booked that would no longer fit, is refused — and if any room is refused, none are moved."
          confirmLabel="Change type"
          confirmDisabled={!targetTypeId || submitting || isOffline}
          onConfirm={confirmChangeType}
          onCancel={() => setDialog(null)}
        >
          <div className={roomStyles.dialogFields}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>New room type</span>
              <select className={formStyles.select} value={targetTypeId} onChange={(event) => setTargetTypeId(event.target.value)}>
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
              <span className={formStyles.label}>Reason (optional)</span>
              <textarea className={roomStyles.textarea} value={changeReason} onChange={(event) => setChangeReason(event.target.value)} />
            </label>
          </div>
        </ConfirmDialog>
      )}

      {dialog?.kind === 'archive' && (
        <ConfirmDialog
          title={`Archive ${plural(dialog.roomIds.length, 'room')}?`}
          consequence="Archived rooms disappear from every list and cannot be booked, checked into or assigned. Their history is kept, and their numbers stay reserved — you can restore them later. A room with a guest in it is refused, and if any room is refused, none are archived."
          requireReason
          confirmLabel="Archive"
          confirmDisabled={submitting || isOffline}
          onConfirm={confirmArchive}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'remove' && dialog.usage.deletable && (
        <ConfirmDialog
          title={`Delete room ${dialog.room.room_number}?`}
          consequence="This permanently removes the room — it has never been used, so nothing else is affected — and its number becomes available again. This cannot be undone."
          requireReason
          confirmLabel="Delete room"
          confirmDisabled={submitting || isOffline}
          onConfirm={confirmRemove}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'remove' && !dialog.usage.deletable && (
        <ConfirmDialog
          title={`Room ${dialog.room.room_number} can't be deleted`}
          consequence={`Room ${dialog.room.room_number} can't be deleted because ${describeUsage(dialog.usage)}. Folios and stay history must survive, so the room can only be archived — its history is kept and you can restore it later.`}
          requireReason
          confirmLabel="Archive instead"
          confirmDisabled={submitting || isOffline}
          onConfirm={(reason) => confirmArchive(reason, [String(dialog.room.id)])}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
