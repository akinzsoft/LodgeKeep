import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { portalApi, ApiError } from '../../shared/api/index.js';
import { useBranding } from '../branding/BrandingContext.jsx';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/**
 * AvailabilitySearchScreen — PRODUCT_REQUIREMENTS.md §3.14: dates in, a
 * list of room types with their live sellable count and rate out. No
 * separate "room detail" page — each result's own "Book" button goes
 * straight to checkout, the same "don't split a screen that doesn't need
 * splitting" reasoning `CashieringScreen`'s own header already used
 * elsewhere in this codebase.
 */
export function AvailabilitySearchScreen() {
  const { propertySlug } = useOutletContext();
  const navigate = useNavigate();
  const { branding } = useBranding();
  const currencyCode = branding?.baseCurrency ?? 'USD';

  const [form, setForm] = useState({ arrival_date: '', departure_date: '', adults: '1', children: '0' });
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [searching, setSearching] = useState(false);

  async function handleSearch(event) {
    event.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const roomTypes = await portalApi.listRoomTypes(propertySlug);
      const withAvailability = await Promise.all(
        roomTypes.map(async (roomType) => {
          const availability = await portalApi.checkAvailability({
            propertySlug,
            roomTypeId: roomType.id,
            arrivalDate: form.arrival_date,
            departureDate: form.departure_date,
          });
          return { ...roomType, minSellable: availability.minSellable };
        })
      );
      setResults(withAvailability);
    } catch (caught) {
      setResults([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not search availability.');
    } finally {
      setSearching(false);
    }
  }

  function handleBook(roomType) {
    const params = new URLSearchParams({
      room_type_id: roomType.id,
      room_type_name: roomType.name,
      rate: roomType.base_rate,
      arrival_date: form.arrival_date,
      departure_date: form.departure_date,
      adults: form.adults,
      children: form.children,
    });
    navigate(`/portal/${propertySlug}/book?${params}`);
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Find a room</h1>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <Card>
        <form className={formStyles.form} onSubmit={handleSearch}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Arrival</span>
              <input
                className={formStyles.input}
                type="date"
                value={form.arrival_date}
                onChange={(event) => setForm({ ...form, arrival_date: event.target.value })}
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Departure</span>
              <input
                className={formStyles.input}
                type="date"
                value={form.departure_date}
                onChange={(event) => setForm({ ...form, departure_date: event.target.value })}
                required
              />
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Adults</span>
              <input
                className={formStyles.input}
                type="number"
                min="1"
                value={form.adults}
                onChange={(event) => setForm({ ...form, adults: event.target.value })}
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Children</span>
              <input
                className={formStyles.input}
                type="number"
                min="0"
                value={form.children}
                onChange={(event) => setForm({ ...form, children: event.target.value })}
              />
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={searching}>
              Search
            </Button>
          </div>
        </form>
      </Card>

      {results !== null && (
        <DataTable
          title="Available room types"
          state={results.length === 0 ? 'empty' : 'success'}
          emptyMessage="No room types are available for these dates."
          columns={[
            { key: 'name', label: 'Room type' },
            { key: 'base_rate', label: 'Rate / night', align: 'right', render: (row) => <Money amount={row.base_rate} currencyCode={currencyCode} /> },
            { key: 'minSellable', label: 'Available', align: 'right' },
          ]}
          rows={results}
          rowKey={(row) => row.id}
          actions={(row) => (
            <Button size="compact" disabled={row.minSellable <= 0} onClick={() => handleBook(row)}>
              {row.minSellable > 0 ? 'Book' : 'Sold out'}
            </Button>
          )}
        />
      )}
    </div>
  );
}
