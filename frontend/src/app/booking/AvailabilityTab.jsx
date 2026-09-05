import { useEffect, useState } from 'react';
import { Card, Button, DataTable, StatusPill } from '../../shared/components/index.js';
import { setupApi, reservationsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './BookingForm.module.css';
import styles from './BookingScreen.module.css';

/**
 * Availability search + booking — PRODUCT_REQUIREMENTS.md §3.2's
 * "Availability search — date range + room type + occupancy; results show
 * sellable inventory vs overbooking threshold, visual warning at/over 100%
 * capacity" and "Reservation create/edit — guest profile lookup or create,
 * rate code selection ... special requests."
 *
 * Guest lookup is a plain dropdown, not a search box — this pass's guests
 * stub has no search endpoint (see the `guests` migration's own scope
 * note), so every tenant guest is listed and a new one can be added inline.
 */
export function AvailabilityTab({ isOffline = false } = {}) {
  const [roomTypes, setRoomTypes] = useState(null);
  const [rateCodes, setRateCodes] = useState(null);
  const [guests, setGuests] = useState(null);

  const [search, setSearch] = useState({ room_type_id: '', arrival_date: '', departure_date: '' });
  const [availability, setAvailability] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [searching, setSearching] = useState(false);

  const [booking, setBooking] = useState({
    guest_id: '',
    rate_code_id: '',
    adults: '1',
    children: '0',
    as_hold: false,
    allow_waitlist: false,
  });
  const [newGuest, setNewGuest] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [addingGuest, setAddingGuest] = useState(false);
  const [bookError, setBookError] = useState(null);
  const [bookSuccess, setBookSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function reloadReferenceData() {
    try {
      const [rt, rc, g] = await Promise.all([
        setupApi.listRoomTypes(),
        setupApi.listRateCodes(),
        reservationsApi.listGuests(),
      ]);
      setRoomTypes(rt);
      setRateCodes(rc);
      setGuests(g);
    } catch (caught) {
      setSearchError(caught instanceof ApiError ? caught.message : 'Could not load room types, rate codes, or guests.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadReferenceData();
  }, []);

  async function handleSearch(event) {
    event.preventDefault();
    setSearching(true);
    setSearchError(null);
    setBookSuccess(null);
    try {
      setAvailability(
        await reservationsApi.checkAvailability({
          roomTypeId: search.room_type_id,
          arrivalDate: search.arrival_date,
          departureDate: search.departure_date,
        })
      );
    } catch (caught) {
      setAvailability(null);
      setSearchError(caught instanceof ApiError ? caught.message : 'Could not check availability.');
    } finally {
      setSearching(false);
    }
  }

  async function handleAddGuest(event) {
    event.preventDefault();
    setAddingGuest(true);
    setBookError(null);
    try {
      const guest = await reservationsApi.createGuest(newGuest);
      setGuests((current) => [...(current ?? []), guest]);
      setBooking((current) => ({ ...current, guest_id: String(guest.id) }));
      setNewGuest({ first_name: '', last_name: '', email: '', phone: '' });
    } catch (caught) {
      setBookError(caught instanceof ApiError ? caught.message : 'Could not add the guest.');
    } finally {
      setAddingGuest(false);
    }
  }

  async function handleBook(event) {
    event.preventDefault();
    setSubmitting(true);
    setBookError(null);
    setBookSuccess(null);
    try {
      const reservation = await reservationsApi.createReservation({
        guest_id: booking.guest_id,
        room_type_id: search.room_type_id,
        rate_code_id: booking.rate_code_id,
        arrival_date: search.arrival_date,
        departure_date: search.departure_date,
        adults: Number(booking.adults),
        children: Number(booking.children),
        as_hold: booking.as_hold,
        allow_waitlist: booking.allow_waitlist,
      });
      setBookSuccess(
        reservation.status === 'waitlisted'
          ? `Added to the waitlist (confirmation ${reservation.confirmation_number}).`
          : `Booked — confirmation ${reservation.confirmation_number}.`
      );
      const res = await reservationsApi.checkAvailability({
        roomTypeId: search.room_type_id,
        arrivalDate: search.arrival_date,
        departureDate: search.departure_date,
      });
      setAvailability(res);
    } catch (caught) {
      setBookError(caught instanceof ApiError ? caught.message : 'Could not create the reservation.');
    } finally {
      setSubmitting(false);
    }
  }

  const loading = roomTypes === null || rateCodes === null || guests === null;

  return (
    <div className={styles.page}>
      <Card title="Search availability">
        {searchError && (
          <p role="alert" className={formStyles.errorBanner}>
            {searchError}
          </p>
        )}
        {loading ? (
          <p className={styles.loading}>Loading…</p>
        ) : (
          <form className={formStyles.form} onSubmit={handleSearch}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Room type</span>
                <select
                  className={formStyles.select}
                  value={search.room_type_id}
                  onChange={(event) => setSearch({ ...search, room_type_id: event.target.value })}
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
                <span className={formStyles.label}>Arrival</span>
                <input
                  type="date"
                  className={formStyles.input}
                  value={search.arrival_date}
                  onChange={(event) => setSearch({ ...search, arrival_date: event.target.value })}
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Departure</span>
                <input
                  type="date"
                  className={formStyles.input}
                  value={search.departure_date}
                  onChange={(event) => setSearch({ ...search, departure_date: event.target.value })}
                  required
                />
              </label>
            </div>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={searching}>
                Search
              </Button>
            </div>
          </form>
        )}
      </Card>

      {availability && (
        <>
          <DataTable
            title="Availability"
            state="success"
            columns={[
              { key: 'stayDate', label: 'Date' },
              { key: 'physicalCount', label: 'Physical', align: 'right' },
              { key: 'roomsSold', label: 'Sold', align: 'right' },
              { key: 'sellable', label: 'Sellable', align: 'right' },
              {
                key: 'status',
                label: 'Status',
                render: (row) =>
                  row.sellable === 0 ? (
                    <StatusPill tone="danger" label="Fully sold" />
                  ) : (
                    <StatusPill tone="success" label="Available" />
                  ),
              },
            ]}
            rows={availability.nights}
            rowKey={(row) => row.stayDate}
          />
          {availability.minSellable === 0 && (
            <p role="alert" className={formStyles.errorBanner}>
              Fully booked for at least one night in this range — a new booking will need the waitlist.
            </p>
          )}
        </>
      )}

      {availability && (
        <Card title="Book this stay">
          {bookError && (
            <p role="alert" className={formStyles.errorBanner}>
              {bookError}
            </p>
          )}
          {bookSuccess && <p className={formStyles.disabledNotice}>{bookSuccess}</p>}

          <form className={formStyles.form} onSubmit={handleBook}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Guest</span>
                <select
                  className={formStyles.select}
                  value={booking.guest_id}
                  onChange={(event) => setBooking({ ...booking, guest_id: event.target.value })}
                  required
                >
                  <option value="" disabled>
                    Select a guest
                  </option>
                  {(guests ?? []).map((guest) => (
                    <option key={guest.id} value={guest.id}>
                      {guest.first_name} {guest.last_name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Rate code</span>
                <select
                  className={formStyles.select}
                  value={booking.rate_code_id}
                  onChange={(event) => setBooking({ ...booking, rate_code_id: event.target.value })}
                  required
                >
                  <option value="" disabled>
                    Select a rate code
                  </option>
                  {(rateCodes ?? []).map((rc) => (
                    <option key={rc.id} value={rc.id}>
                      {rc.code} — {rc.base_rate} {rc.currency}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Adults</span>
                <input
                  type="number"
                  min="1"
                  className={formStyles.input}
                  value={booking.adults}
                  onChange={(event) => setBooking({ ...booking, adults: event.target.value })}
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Children</span>
                <input
                  type="number"
                  min="0"
                  className={formStyles.input}
                  value={booking.children}
                  onChange={(event) => setBooking({ ...booking, children: event.target.value })}
                />
              </label>
            </div>

            <div className={formStyles.row}>
              <label className={formStyles.checkboxField}>
                <input
                  type="checkbox"
                  className={formStyles.checkbox}
                  checked={booking.as_hold}
                  onChange={(event) => setBooking({ ...booking, as_hold: event.target.checked })}
                />
                <span className={formStyles.label}>Hold only (tentative)</span>
              </label>
              <label className={formStyles.checkboxField}>
                <input
                  type="checkbox"
                  className={formStyles.checkbox}
                  checked={booking.allow_waitlist}
                  onChange={(event) => setBooking({ ...booking, allow_waitlist: event.target.checked })}
                />
                <span className={formStyles.label}>Add to waitlist if fully booked</span>
              </label>
            </div>

            {/* DESIGN_SYSTEM.md §2: "disable actions that would post financial transactions" while offline. */}
            {isOffline && (
              <p role="alert" className={formStyles.errorBanner}>
                You&rsquo;re offline — booking is disabled until the connection returns.
              </p>
            )}
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={submitting} disabled={isOffline || !booking.guest_id || !booking.rate_code_id}>
                Book
              </Button>
            </div>
          </form>

          <details>
            <summary className={formStyles.label}>New guest</summary>
            <form className={formStyles.form} onSubmit={handleAddGuest}>
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>First name</span>
                  <input
                    className={formStyles.input}
                    value={newGuest.first_name}
                    onChange={(event) => setNewGuest({ ...newGuest, first_name: event.target.value })}
                    required
                  />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Last name</span>
                  <input
                    className={formStyles.input}
                    value={newGuest.last_name}
                    onChange={(event) => setNewGuest({ ...newGuest, last_name: event.target.value })}
                    required
                  />
                </label>
              </div>
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Email</span>
                  <input
                    type="email"
                    className={formStyles.input}
                    value={newGuest.email}
                    onChange={(event) => setNewGuest({ ...newGuest, email: event.target.value })}
                  />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Phone</span>
                  <input
                    className={formStyles.input}
                    value={newGuest.phone}
                    onChange={(event) => setNewGuest({ ...newGuest, phone: event.target.value })}
                  />
                </label>
              </div>
              <div className={formStyles.actionsRow}>
                <Button type="submit" variant="secondary" loading={addingGuest}>
                  Add guest
                </Button>
              </div>
            </form>
          </details>
        </Card>
      )}
    </div>
  );
}
