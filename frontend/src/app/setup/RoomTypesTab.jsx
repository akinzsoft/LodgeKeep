import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/** PRODUCT_REQUIREMENTS.md's "Room type editor — code, name, occupancy, base rate, description, photo upload." No photo upload flow exists yet — see PropertyTab's own note on the same gap for logo_url. */
export function RoomTypesTab({ activeProperty, disabled }) {
  const [roomTypes, setRoomTypes] = useState(null);
  const [form, setForm] = useState({ code: '', name: '', default_occupancy: '2', base_rate: '', description: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function reload() {
    try {
      setRoomTypes(await setupApi.listRoomTypes());
    } catch (caught) {
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

  return (
    <div className={styles.page}>
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
      />

      <Card title="Add a room type">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
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
