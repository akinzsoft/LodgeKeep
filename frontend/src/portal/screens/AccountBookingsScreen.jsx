import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Card, DataTable, StatusPill, Button } from '../../shared/components/index.js';
import { portalApi, ApiError } from '../../shared/api/index.js';
import { statusTone, statusLabel } from '../../app/booking/status.js';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/**
 * AccountBookingsScreen — PRODUCT_REQUIREMENTS.md §3.16's "online check-in"
 * screen's prerequisite: a signed-in guest's own booking list plus a detail
 * view, the same "list, select, see detail" shape `ProfilesScreen` already
 * established for a staff-side lookup screen with no deep link into a
 * specific record. Reachable only while authenticated — `PortalApp`'s own
 * route is nested inside `GuestAuthProvider`, but this screen still handles
 * an unauthenticated view directly (a bookmarked link, a stale tab after
 * logout) rather than assuming the router state always matches reality.
 */
export function AccountBookingsScreen() {
  const { propertySlug } = useOutletContext();
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detailError, setDetailError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    portalApi
      .listMyBookings()
      .then((result) => {
        if (!cancelled) setBookings(result);
      })
      .catch((caught) => {
        if (cancelled) return;
        setBookings([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load your bookings.');
      });
    return () => {
      cancelled = true;
    };
  }, [propertySlug]);

  async function handleSelect(booking) {
    setSelected(booking);
    setDetailError(null);
    try {
      setSelected(await portalApi.getMyBooking(booking.id));
    } catch (caught) {
      setDetailError(caught instanceof ApiError ? caught.message : 'Could not load this booking.');
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>My bookings</h1>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <DataTable
        title="Bookings"
        state={bookings === null ? 'loading' : bookings.length === 0 ? 'empty' : 'success'}
        emptyMessage="You don't have any bookings yet."
        columns={[
          { key: 'confirmation_number', label: 'Confirmation' },
          { key: 'arrival_date', label: 'Arrival' },
          { key: 'departure_date', label: 'Departure' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={statusTone(row.status)} label={statusLabel(row.status)} /> },
        ]}
        rows={bookings ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" variant="ghost" onClick={() => handleSelect(row)}>
            View
          </Button>
        )}
      />

      {selected && (
        <Card title={`Booking ${selected.confirmation_number}`}>
          {detailError ? (
            <p role="alert" className={formStyles.errorBanner}>
              {detailError}
            </p>
          ) : (
            <dl className={formStyles.form}>
              <div>
                <dt className={formStyles.label}>Status</dt>
                <dd>
                  <StatusPill tone={statusTone(selected.status)} label={statusLabel(selected.status)} />
                </dd>
              </div>
              <div>
                <dt className={formStyles.label}>Dates</dt>
                <dd>
                  {selected.arrival_date} → {selected.departure_date}
                </dd>
              </div>
              <div>
                <dt className={formStyles.label}>Guests</dt>
                <dd>
                  {selected.adults} adult{selected.adults === 1 ? '' : 's'}
                  {selected.children > 0 ? `, ${selected.children} child${selected.children === 1 ? '' : 'ren'}` : ''}
                </dd>
              </div>
            </dl>
          )}
        </Card>
      )}
    </div>
  );
}
