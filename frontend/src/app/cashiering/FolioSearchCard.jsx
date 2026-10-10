import { useState } from 'react';
import { Card, DataTable, Button, FolioBalance } from '../../shared/components/index.js';
import { cashieringApi, ApiError } from '../../shared/api/index.js';
import formStyles from './CashieringForm.module.css';

/**
 * FolioSearchCard — Folio Lookup by what a cashier actually knows: guest
 * name, phone number, or the room number of a checked-in guest. The server
 * decides which it is (`GET /front-desk/folio-search`); this just sends the
 * text. Several matches are listed with name, room, dates and balance so the
 * right one can be picked; exactly one match opens straight away.
 *
 * Searches cannot overlap: the Search button is disabled while one is running
 * (which also blocks Enter), so no stale-response guard is needed.
 *
 * A checked-out guest (found by name/phone within the last week) has no room
 * or open-folio balance on this join, so those cells read "—"; their folio
 * still opens.
 */
export function FolioSearchCard({ isOffline = false, onOpenFolio }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null);
  const [searched, setSearched] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSearch(event) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const found = await cashieringApi.searchFolios(q);
      setSearched(q);
      if (found.length === 1) {
        setRows(null);
        onOpenFolio(found[0].id);
      } else {
        setRows(found);
      }
    } catch (caught) {
      setRows(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not search for a guest.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Find a guest's folio">
      <form className={formStyles.row} onSubmit={handleSearch}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Guest name, phone number or room</span>
          <input
            className={formStyles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Ada, 0803 555 1212 or 204"
          />
        </label>
        <div className={formStyles.actionsRow}>
          <Button type="submit" loading={busy} disabled={isOffline || !query.trim()}>
            Search
          </Button>
        </div>
      </form>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      {rows !== null && (
        <DataTable
          title={`Matches for "${searched}"`}
          state={rows.length === 0 ? 'empty' : 'success'}
          emptyMessage="No in-house or recently checked-out guest matches. Check the spelling, or try the room number."
          columns={[
            {
              key: 'guest_name',
              label: 'Guest',
              render: (row) => `${row.guest_first_name ?? ''} ${row.guest_last_name ?? ''}`.trim() || '—',
            },
            { key: 'guest_phone', label: 'Phone', render: (row) => row.guest_phone ?? '—' },
            { key: 'room_number', label: 'Room', render: (row) => row.room_number ?? '—' },
            { key: 'arrival_date', label: 'Arrival' },
            { key: 'departure_date', label: 'Departure' },
            { key: 'status', label: 'Status', render: (row) => (row.status === 'checked_in' ? 'In house' : 'Checked out') },
            {
              key: 'folio_balance',
              label: 'Balance',
              align: 'right',
              render: (row) =>
                row.folio_balance == null ? '—' : <FolioBalance amount={row.folio_balance} currencyCode={row.folio_currency} />,
            },
          ]}
          rows={rows}
          rowKey={(row) => row.id}
          actions={(row) => (
            <Button size="compact" variant="secondary" onClick={() => onOpenFolio(row.id)}>
              Open folio
            </Button>
          )}
        />
      )}
    </Card>
  );
}
