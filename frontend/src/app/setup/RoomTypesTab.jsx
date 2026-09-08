import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/**
 * PRODUCT_REQUIREMENTS.md's "Room type editor — code, name, occupancy, base
 * rate, description, photo upload." No photo upload flow exists yet — see
 * PropertyTab's own note on the same gap for logo_url.
 *
 * Gap closure (user-reported): "update room type and Base rate only super
 * admin" — `PATCH /room-types/:id` (`updateRoomType`) has existed since
 * Phase 1 but was never actually called from anywhere in the frontend; this
 * tab had create-only. The Edit button/form below is real now, gated on the
 * backend's real `room_types.update` permission (super_admin only,
 * SECURITY.md §5) — like every other action in this app, no client-side
 * role check exists to hide the button (no endpoint yet returns what the
 * signed-in user can actually do), so a non-super_admin sees the same
 * button and gets the real backend 403, surfaced through the same error
 * banner every other action here already uses.
 */
export function RoomTypesTab({ activeProperty, disabled }) {
  const [roomTypes, setRoomTypes] = useState(null);
  const [form, setForm] = useState({ code: '', name: '', default_occupancy: '2', base_rate: '', description: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ code: '', name: '', default_occupancy: '2', base_rate: '', description: '' });

  async function reload() {
    try {
      setRoomTypes(await setupApi.listRoomTypes());
    } catch (caught) {
      // DESIGN_SYSTEM.md §2's error state, not empty — but the visible error
      // banner below is what actually says so; `[]` is what stops this
      // table showing a loading skeleton forever (the same bug class
      // `SetupScreen`'s own `reloadProperties` comment already documents).
      setRoomTypes([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load room types.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return (
      <p className={formStyles.disabledNotice}>
        Create a property first — room types belong to one property.
      </p>
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await setupApi.createRoomType({
        code: form.code,
        name: form.name,
        default_occupancy: Number(form.default_occupancy),
        base_rate: form.base_rate,
        description: form.description || undefined,
      });
      setForm({ code: '', name: '', default_occupancy: '2', base_rate: '', description: '' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the room type.');
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(roomType) {
    setError(null);
    setEditingId(roomType.id);
    setEditForm({
      code: roomType.code,
      name: roomType.name,
      default_occupancy: String(roomType.default_occupancy),
      base_rate: roomType.base_rate,
      description: roomType.description ?? '',
    });
  }

  async function handleEditSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await setupApi.updateRoomType(editingId, {
        code: editForm.code,
        name: editForm.name,
        default_occupancy: Number(editForm.default_occupancy),
        base_rate: editForm.base_rate,
        description: editForm.description || undefined,
      });
      setEditingId(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update the room type.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <DataTable
        title="Room types"
        state={roomTypes === null ? 'loading' : roomTypes.length === 0 ? 'empty' : 'success'}
        emptyMessage="No room types yet — add one below."
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'default_occupancy', label: 'Occupancy', align: 'right' },
          {
            key: 'base_rate',
            label: 'Base rate',
            align: 'right',
            render: (row) => <Money amount={row.base_rate} currencyCode={activeProperty.base_currency} />,
          },
        ]}
        rows={roomTypes ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" variant="secondary" onClick={() => startEdit(row)}>
            Edit
          </Button>
        )}
      />

      {editingId && (
        <Card title="Edit room type">
          <p className={formStyles.disabledNotice}>Base rate changes only take effect for nights booked after this change.</p>
          <form className={formStyles.form} onSubmit={handleEditSubmit}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Code</span>
                <input
                  className={formStyles.input}
                  value={editForm.code}
                  onChange={(event) => setEditForm({ ...editForm, code: event.target.value })}
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Name</span>
                <input
                  className={formStyles.input}
                  value={editForm.name}
                  onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                  required
                />
              </label>
            </div>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Default occupancy</span>
                <input
                  className={formStyles.input}
                  type="number"
                  min="1"
                  value={editForm.default_occupancy}
                  onChange={(event) => setEditForm({ ...editForm, default_occupancy: event.target.value })}
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Base rate ({activeProperty.base_currency})</span>
                <input
                  className={formStyles.input}
                  inputMode="decimal"
                  value={editForm.base_rate}
                  onChange={(event) => setEditForm({ ...editForm, base_rate: event.target.value })}
                  required
                />
              </label>
            </div>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Description</span>
              <input
                className={formStyles.input}
                value={editForm.description}
                onChange={(event) => setEditForm({ ...editForm, description: event.target.value })}
              />
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={submitting}>
                Save changes
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Add a room type">
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input
                className={formStyles.input}
                value={form.code}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
                placeholder="DLX"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input
                className={formStyles.input}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Deluxe"
                required
              />
            </label>
          </div>

          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Default occupancy</span>
              <input
                className={formStyles.input}
                type="number"
                min="1"
                value={form.default_occupancy}
                onChange={(event) => setForm({ ...form, default_occupancy: event.target.value })}
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Base rate ({activeProperty.base_currency})</span>
              <input
                className={formStyles.input}
                inputMode="decimal"
                value={form.base_rate}
                onChange={(event) => setForm({ ...form, base_rate: event.target.value })}
                placeholder="150.00"
                required
              />
            </label>
          </div>

          <label className={formStyles.field}>
            <span className={formStyles.label}>Description</span>
            <input
              className={formStyles.input}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>

          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting}>
              Add room type
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
