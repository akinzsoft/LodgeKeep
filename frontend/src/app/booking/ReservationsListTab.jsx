import { useEffect, useRef, useState } from 'react';
import { DataTable, StatusPill, Button, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatDate, nightsBetween } from '../../shared/format/dates.js';
import { reservationsApi, ApiError } from '../../shared/api/index.js';
import { statusTone, statusLabel } from './status.js';
import { ConfirmationRef, shortReference } from './ConfirmationRef.jsx';
import formStyles from './BookingForm.module.css';
import styles from './BookingScreen.module.css';

const STATUS_FILTERS = ['', 'confirmed', 'tentative', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'waitlisted'];
const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

/**
 * PRODUCT_REQUIREMENTS.md §3.2's reservation list. User-reported: the list
 * showed only a 26-character confirmation code, oldest first, with no way
 * to find a booking. Now each row says whose booking it is (guest and
 * phone), for what (room type), when (dates and nights) and what is owed,
 * newest first, 25 to a page, searchable by guest name, phone or
 * confirmation number — all server-side (`GET /reservations?search=&sort=
 * newest&limit=&offset=`), so it stays fast however long the history gets.
 */
export function ReservationsListTab({ isOffline = false } = {}) {
  const [result, setResult] = useState(null); // { rows, total }
  const [status, setStatus] = useState('');
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState(''); // the debounced search actually sent
  const [page, setPage] = useState(0);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  // Typing fires several searches; only the latest request's answer may land.
  const requestSeq = useRef(0);

  async function reload({ nextStatus = status, nextQuery = query, nextPage = page } = {}) {
    requestSeq.current += 1;
    const seq = requestSeq.current;
    try {
      const next = await reservationsApi.searchReservations({ status: nextStatus, search: nextQuery, limit: PAGE_SIZE, offset: nextPage * PAGE_SIZE });
      if (seq !== requestSeq.current) return;
      setResult(next);
      setError(null);
    } catch (caught) {
      if (seq !== requestSeq.current) return;
      setResult({ rows: [], total: 0 });
      setError(caught instanceof ApiError ? caught.message : 'Could not load reservations.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch whenever the filter, search or page changes; no data-fetching library exists yet to own this
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload reads these same three values
  }, [status, query, page]);

  // Debounce typing so every keystroke doesn't hit the server.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(searchText.trim());
      setPage(0);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  async function handleCancel(reason) {
    try {
      await reservationsApi.cancelReservation(cancelling.id, reason);
      setCancelling(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel the reservation.');
      setCancelling(null);
    }
  }

  const rows = result?.rows ?? [];
  const total = result?.total ?? 0;
  const firstShown = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastShown = Math.min((page + 1) * PAGE_SIZE, total);
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0);
  const filtered = Boolean(query || status);

  return (
    <>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {/* Outside DataTable's own toolbar slot, deliberately: Card only
          renders `children` — toolbar included — while `state ===
          'success'`. A search or filter with zero matches is a real,
          unremarkable case; controls that vanished exactly then would trap
          the user on it. */}
      <div className={styles.toolbar}>
        <label className={`${formStyles.field} ${styles.toolbarSearch}`}>
          <span className={formStyles.label}>Search</span>
          <input
            type="search"
            className={formStyles.input}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Guest name, phone or confirmation number"
          />
        </label>
        <label className={`${formStyles.field} ${styles.toolbarFilter}`}>
          <span className={formStyles.label}>Status</span>
          <select
            className={formStyles.select}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(0);
            }}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? statusLabel(s) : 'All statuses'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DataTable
        title="Reservations"
        state={result === null ? 'loading' : rows.length === 0 ? 'empty' : 'success'}
        emptyMessage={filtered ? 'No reservations match this search.' : 'No reservations yet.'}
        columns={[
          { key: 'confirmation_number', label: 'Reference', render: (row) => <ConfirmationRef value={row.confirmation_number} /> },
          {
            key: 'guest',
            label: 'Guest',
            render: (row) => (
              <span className={styles.guestCell}>
                <span className={styles.guestName}>{[row.guest_first_name, row.guest_last_name].filter(Boolean).join(' ') || '—'}</span>
                {row.guest_phone && <span className={styles.subText}>{row.guest_phone}</span>}
              </span>
            ),
          },
          { key: 'room_type', label: 'Room type', render: (row) => row.room_type_name ?? '—' },
          {
            key: 'stay',
            label: 'Stay',
            render: (row) => {
              const nights = nightsBetween(row.arrival_date, row.departure_date);
              return (
                <span className={styles.guestCell}>
                  <span className={styles.nowrap}>
                    {formatDate(row.arrival_date, { weekday: true, year: false })} → {formatDate(row.departure_date, { weekday: true })}
                  </span>
                  <span className={styles.subText}>
                    {nights} {nights === 1 ? 'night' : 'nights'} · {row.adults} {row.adults === 1 ? 'adult' : 'adults'}
                    {row.children > 0 ? `, ${row.children} ${row.children === 1 ? 'child' : 'children'}` : ''}
                  </span>
                </span>
              );
            },
          },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={statusTone(row.status)} label={statusLabel(row.status)} /> },
          {
            key: 'balance',
            label: 'Balance',
            align: 'right',
            render: (row) =>
              row.folio_balance == null ? (
                <span className={styles.subText}>No open folio</span>
              ) : (
                <span className={styles.nowrap}>
                  <Money amount={row.folio_balance} currencyCode={row.folio_currency} />
                </span>
              ),
          },
        ]}
        rows={rows}
        rowKey={(row) => row.id}
        actions={(row) =>
          ['confirmed', 'tentative', 'waitlisted'].includes(row.status) && (
            // DESIGN_SYSTEM.md §2: cancellation releases inventory and is
            // consequential enough to disable while offline, same as the
            // financial-adjacent actions elsewhere in this module.
            <Button variant="danger" size="compact" disabled={isOffline} onClick={() => setCancelling(row)}>
              Cancel
            </Button>
          )
        }
        errorMessage={error}
      />
      {result !== null && total > 0 && (
        <nav className={styles.pager} aria-label="Reservation pages">
          <span>
            Showing {firstShown}–{lastShown} of {total}
          </span>
          <span className={styles.pagerButtons}>
            <Button variant="secondary" size="compact" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button variant="secondary" size="compact" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </span>
        </nav>
      )}

      {cancelling && (
        <ConfirmDialog
          title="Cancel reservation"
          consequence={`This cancels reservation ${shortReference(cancelling.confirmation_number)} for ${[cancelling.guest_first_name, cancelling.guest_last_name].filter(Boolean).join(' ') || 'this guest'}${['confirmed', 'tentative'].includes(cancelling.status) ? ' and releases its held inventory immediately' : ''}. This cannot be undone.`}
          requireReason
          confirmLabel="Confirm cancellation"
          onConfirm={handleCancel}
          onCancel={() => setCancelling(null)}
        />
      )}
    </>
  );
}
