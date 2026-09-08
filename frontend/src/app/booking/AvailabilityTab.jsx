import { useEffect, useState } from 'react';
import { Card, Button, DataTable, StatusPill } from '../../shared/components/index.js';
import { setupApi, reservationsApi, cashieringApi, ApiError } from '../../shared/api/index.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import { Money, isBalanceSettled, describeBalanceState } from '../../shared/format/money.jsx';
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
 *
 * Gap closure — two additions, deliberately answering different questions
 * (see `backend/src/shared/room-availability.js`'s own header for the full
 * reasoning):
 * 1. "Rooms free right now" — actual room numbers, shown ONLY when the
 *    searched arrival date is the property's own CURRENT business date
 *    (never wall-clock "today"), since no data in this schema can name a
 *    specific physical room for a future, not-yet-arrived stay — a room is
 *    assigned only at check-in (Phase 2's confirmed decision, unchanged).
 *    For every other search this stays exactly the aggregate sellable
 *    table it always was.
 * 2. "Preferred room" — an optional, non-binding request recorded on the
 *    reservation (`preferred_room_id`). Sourced from `listEligiblePreferredRooms`
 *    (gap closure, user-reported), not every room of the searched type — a
 *    room already committed, by preference or actual check-in, to another
 *    reservation whose dates overlap this search is excluded from the
 *    list. This is still not a lock: `checkIn` still accepts any room, and
 *    the exclusion only narrows what the picker OFFERS, never what could be
 *    submitted directly against the API. See the backend's own
 *    `listEligiblePreferredRooms` header for the exact rule, including why
 *    it is DATE-OVERLAP aware rather than "hide until the other stay ends
 *    entirely" — a room preferred for next week still appears for a
 *    December search.
 *
 * Gap closure (user-reported): "pay at the point of booking." A successful,
 * CONFIRMED booking (never a hold or a waitlisted one — neither holds a
 * real room to bill yet) immediately opens its folio and posts every
 * night's room charge (`reservationsApi.openBookingFolio`), then offers
 * real Cash/Card payment against it — the same `cashieringApi` endpoints
 * the admin Cashiering screen already uses. Deliberately NOT the Guest
 * Portal's own hold-and-cancel-if-unpaid shape (confirmed with the user
 * before building this): the reservation stays confirmed whether or not
 * payment happens now, and an unpaid balance is a normal, expected outcome
 * here, settled later via Cashiering or at check-out — never a reason to
 * roll the booking back.
 */
export function AvailabilityTab({ activeProperty, isOffline = false } = {}) {
  const [roomTypes, setRoomTypes] = useState(null);
  const [rateCodes, setRateCodes] = useState(null);
  const [guests, setGuests] = useState(null);

  const [search, setSearch] = useState({ room_type_id: '', arrival_date: '', departure_date: '' });
  const [availability, setAvailability] = useState(null);
  const [freeRoomsNow, setFreeRoomsNow] = useState(null);
  const [eligiblePreferredRooms, setEligiblePreferredRooms] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [searching, setSearching] = useState(false);

  const [booking, setBooking] = useState({
    guest_id: '',
    rate_code_id: '',
    adults: '1',
    children: '0',
    as_hold: false,
    allow_waitlist: false,
    preferred_room_id: '',
  });
  const [newGuest, setNewGuest] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [addingGuest, setAddingGuest] = useState(false);
  const [bookError, setBookError] = useState(null);
  const [bookSuccess, setBookSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Gap closure: "pay at the point of booking" — see this file's own header.
  const [folio, setFolio] = useState(null);
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [checkoutAccessCode, setCheckoutAccessCode] = useState(null);
  const [checkoutPaymentId, setCheckoutPaymentId] = useState(null);
  const [openingPopup, setOpeningPopup] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [paymentSuccess, setPaymentSuccess] = useState(null);
  const [capturingPayment, setCapturingPayment] = useState(false);

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

  async function reloadFreeRoomsNow(roomTypeId) {
    try {
      setFreeRoomsNow(await reservationsApi.listFreeRooms(roomTypeId));
    } catch {
      // A 403 (no front_desk.view) or any other failure just hides this
      // panel — it's a bonus alongside the aggregate table, never the
      // reason the whole search fails. Same per-widget degradation
      // HomeDashboard's own KPI cards already use.
      setFreeRoomsNow(null);
    }
  }

  async function reloadEligiblePreferredRooms() {
    try {
      setEligiblePreferredRooms(
        await reservationsApi.listEligiblePreferredRooms({
          roomTypeId: search.room_type_id,
          arrivalDate: search.arrival_date,
          departureDate: search.departure_date,
        })
      );
    } catch {
      // Same per-widget degradation as `reloadFreeRoomsNow` — a failure
      // here just leaves the picker empty (still "No preference"-only),
      // never blocks the search or the booking form itself.
      setEligiblePreferredRooms([]);
    }
  }

  async function handleSearch(event) {
    event.preventDefault();
    setSearching(true);
    setSearchError(null);
    setBookSuccess(null);
    setFreeRoomsNow(null);
    setBooking((current) => ({ ...current, preferred_room_id: '' }));
    // Gap closure (user-reported): "disable the book button ... wen payment
    // is done" — Book stays disabled once `bookSuccess` is set (see the
    // Book button below), for the WHOLE remainder of this search cycle,
    // not just until payment. A fresh Search is the one deliberate
    // boundary that starts a new, independent booking cycle — clearing the
    // previous cycle's payment/folio state here is what allows that.
    setFolio(null);
    setCheckoutUrl(null);
    setCheckoutAccessCode(null);
    setCheckoutPaymentId(null);
    setPaymentError(null);
    setPaymentSuccess(null);
    try {
      const result = await reservationsApi.checkAvailability({
        roomTypeId: search.room_type_id,
        arrivalDate: search.arrival_date,
        departureDate: search.departure_date,
      });
      setAvailability(result);
      if (search.arrival_date === activeProperty?.current_business_date) {
        await reloadFreeRoomsNow(search.room_type_id);
      }
      await reloadEligiblePreferredRooms();
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
    setFolio(null);
    setCheckoutUrl(null);
    setPaymentError(null);
    setPaymentSuccess(null);
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
        ...(booking.preferred_room_id ? { preferred_room_id: booking.preferred_room_id } : {}),
      });
      setBookSuccess(
        reservation.status === 'waitlisted'
          ? `Added to the waitlist (confirmation ${reservation.confirmation_number}).`
          : `Booked — confirmation ${reservation.confirmation_number}.`
      );
      // Gap closure: only a CONFIRMED reservation holds a real room to bill
      // — a hold or a waitlisted booking has nothing to open a folio
      // against yet (`openBookingFolio`'s own backend header). A failure
      // here is shown alongside the payment section, never as a reason the
      // booking itself failed — it already succeeded.
      if (reservation.status === 'confirmed') {
        try {
          const openedFolio = await reservationsApi.openBookingFolio(reservation.id);
          setFolio(openedFolio);
        } catch (caught) {
          setPaymentError(caught instanceof ApiError ? caught.message : 'Could not open the folio for payment.');
        }
      }
      const res = await reservationsApi.checkAvailability({
        roomTypeId: search.room_type_id,
        arrivalDate: search.arrival_date,
        departureDate: search.departure_date,
      });
      setAvailability(res);
      if (search.arrival_date === activeProperty?.current_business_date) {
        await reloadFreeRoomsNow(search.room_type_id);
      }
      setBooking((current) => ({ ...current, preferred_room_id: '' }));
      await reloadEligiblePreferredRooms();
    } catch (caught) {
      setBookError(caught instanceof ApiError ? caught.message : 'Could not create the reservation.');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedGuest = (guests ?? []).find((guest) => String(guest.id) === String(booking.guest_id));
  const isFolioSettled = folio ? isBalanceSettled(folio.balance) : false;

  async function handleCashPayment() {
    setCapturingPayment(true);
    setPaymentError(null);
    setPaymentSuccess(null);
    try {
      await cashieringApi.captureCashPayment(folio.id, { amount: folio.balance, currency: folio.currency });
      const refreshed = await cashieringApi.getFolio(folio.id);
      setFolio(refreshed);
      setPaymentSuccess('Cash payment captured.');
    } catch (caught) {
      setPaymentError(caught instanceof ApiError ? caught.message : 'Could not capture the cash payment.');
    } finally {
      setCapturingPayment(false);
    }
  }

  /**
   * Real Paystack, the same gateway integration Cashiering already uses —
   * not a card terminal integration (none exists in this environment).
   * Generates a real hosted checkout link; the guest (or staff, on their
   * behalf if physically present with the card) completes it there. See
   * `shared/api/cashiering.js`'s own header for the real `meta`-discarding
   * bug this pass found and fixed while wiring this up — without that fix,
   * `authorizationUrl` could never have reached this screen at all.
   */
  async function handleCardPayment() {
    setCapturingPayment(true);
    setPaymentError(null);
    setPaymentSuccess(null);
    setCheckoutUrl(null);
    setCheckoutAccessCode(null);
    setCheckoutPaymentId(null);
    try {
      const result = await cashieringApi.capturePaystackPayment(folio.id, {
        amount: folio.balance,
        currency: folio.currency,
        guestEmail: selectedGuest?.email,
      });
      if (result?.authorizationUrl) {
        setCheckoutUrl(result.authorizationUrl);
        if (result?.accessCode) setCheckoutAccessCode(result.accessCode);
        if (result?.id) setCheckoutPaymentId(result.id);
      } else {
        // The honest-202-partial-success path (`controller.js`'s own
        // `capturePaystackPayment`) — the local intent is real and saved,
        // only reaching the gateway failed (e.g. no sandbox credentials
        // configured in this environment). Never presented as if the whole
        // action failed — the payment attempt is real and retryable.
        setPaymentError(result?.checkoutError ?? 'Could not start the card payment.');
      }
    } catch (caught) {
      setPaymentError(caught instanceof ApiError ? caught.message : 'Could not start the card payment.');
    } finally {
      setCapturingPayment(false);
    }
  }

  /**
   * Gap closure (user-reported): "cant it be done same page." Opens
   * Paystack's own embedded popup for the transaction `handleCardPayment`
   * already started, instead of the guest/staff having to follow the
   * `checkoutUrl` link out to a separate page. See `shared/paystack.js`'s
   * own header for why the popup's own close/success event is never
   * trusted by itself — this always re-verifies through the real backend
   * afterward, same as `CashieringScreen`'s identical flow.
   */
  async function handleResumePaystackPopup() {
    setOpeningPopup(true);
    try {
      await openPaystackPopup({
        accessCode: checkoutAccessCode,
        onClose: async () => {
          const paymentId = checkoutPaymentId;
          setCheckoutUrl(null);
          setCheckoutAccessCode(null);
          setCheckoutPaymentId(null);
          setOpeningPopup(false);
          if (!paymentId) return;
          try {
            await cashieringApi.verifyPayment(paymentId);
          } catch {
            // The verify call itself can fail honestly (e.g. no gateway
            // credentials in this environment) — the folio refresh below
            // still shows the real, current balance either way.
          }
          const refreshed = await cashieringApi.getFolio(folio.id);
          setFolio(refreshed);
        },
      });
    } catch {
      setOpeningPopup(false);
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

      {/* Gap closure: actual room numbers, only meaningful for the property's
          own current business date — every other search stays the aggregate
          table above (see this file's own header). `freeRoomsNow` stays
          `null` until that fetch resolves, and again on a 403/failure
          (`reloadFreeRoomsNow`'s own comment) — either way this panel is
          simply absent rather than showing a misleading empty state. */}
      {availability && freeRoomsNow !== null && (
        <DataTable
          title="Rooms free right now"
          state="success"
          columns={[
            { key: 'room_number', label: 'Room' },
            { key: 'floor', label: 'Floor' },
            { key: 'housekeeping_reported_status', label: 'Housekeeping' },
          ]}
          rows={freeRoomsNow}
          rowKey={(row) => row.id}
          emptyMessage="No rooms of this type are free right now."
        />
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
              <label className={formStyles.field}>
                <span className={formStyles.label}>Preferred room (optional)</span>
                <select
                  className={formStyles.select}
                  value={booking.preferred_room_id}
                  onChange={(event) => setBooking({ ...booking, preferred_room_id: event.target.value })}
                >
                  <option value="">No preference</option>
                  {(eligiblePreferredRooms ?? []).map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.room_number}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {/* A request recorded on the reservation, never a lock — the actual
                room is still assigned at check-in, and this may not be free
                by then. See this file's own header. */}
            <p className={formStyles.disabledNotice}>
              A preferred room is a request only — the actual room is still assigned at check-in and may differ.
            </p>

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
              <Button
                type="submit"
                loading={submitting}
                disabled={isOffline || !booking.guest_id || !booking.rate_code_id || Boolean(bookSuccess)}
              >
                Book
              </Button>
            </div>
            {/*
              Gap closure (user-reported): "disable the book button ... wen
              payment is done" — disabled the instant a reservation exists
              for this search (bookSuccess), not only once payment settles:
              a booked-but-unpaid reservation is still one real booking, and
              a second Book click before paying would create a genuine
              duplicate. Run a new Search to book again.
            */}
            {bookSuccess && (
              <p className={formStyles.disabledNotice}>Run a new search to make another booking.</p>
            )}
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

      {/* Gap closure: "pay at the point of booking" — see this file's own
          header. Only shown after a real folio has been opened for a
          CONFIRMED booking; a hold or waitlisted reservation never reaches
          this state, and there is nothing to show until then. */}
      {folio && (
        <Card title="Payment">
          {paymentError && (
            <p role="alert" className={formStyles.errorBanner}>
              {paymentError}
            </p>
          )}

          {isFolioSettled ? (
            /* Gap closure (user-reported): "disable the book button and
               payment buttons" once payment is done — a positive-state
               summary in place of the now-pointless form controls, rather
               than leaving disabled buttons with no explanation
               (DESIGN_SYSTEM.md §1: status is never colour alone). */
            <div className={formStyles.paymentSettled}>
              {describeBalanceState(folio.balance) && (
                <StatusPill tone={describeBalanceState(folio.balance).tone} label={describeBalanceState(folio.balance).label} />
              )}
              <p className={formStyles.disabledNotice}>
                No balance due — <Money amount={folio.balance} currencyCode={folio.currency} />. Booking and payment for this stay are complete.
              </p>
            </div>
          ) : (
            <>
              {paymentSuccess && <p className={formStyles.disabledNotice}>{paymentSuccess}</p>}
              <p className={formStyles.disabledNotice}>
                Balance due: <Money amount={folio.balance} currencyCode={folio.currency} className={formStyles.balanceOwing} />
              </p>

              {/* Gap closure (user-reported): "make it more profeesional and
                  standard form with the payment button" — one deliberate
                  payment panel, not a raw checkout URL next to a button. */}
              {checkoutUrl && (
                <div className={formStyles.paymentPanel}>
                  <p className={formStyles.paymentPanelHint}>Complete payment securely via Paystack — the popup opens on this page.</p>
                  <div className={formStyles.actionsRow}>
                    {checkoutAccessCode && (
                      <Button type="button" loading={openingPopup} disabled={isOffline} onClick={handleResumePaystackPopup}>
                        Pay now
                      </Button>
                    )}
                    <a className={formStyles.paymentFallbackLink} href={checkoutUrl} target="_blank" rel="noreferrer">
                      Open payment page in a new tab
                    </a>
                  </div>
                </div>
              )}

              {/* Gap closure (user-reported): "the form textfield amt is
                  editable pls correct it" — locked to the folio's real
                  balance; Cash/Card always pay it in full (confirmed with
                  the user: no partial-payment capability needed today). */}
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Amount</span>
                  <input className={`${formStyles.input} ${formStyles.inputLocked}`} value={folio.balance} readOnly aria-readonly="true" />
                </label>
              </div>

              {isOffline && (
                <p role="alert" className={formStyles.errorBanner}>
                  You&rsquo;re offline — payment is disabled until the connection returns.
                </p>
              )}

              <div className={formStyles.actionsRow}>
                <Button type="button" loading={capturingPayment} disabled={isOffline} onClick={handleCashPayment}>
                  Cash
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  loading={capturingPayment}
                  disabled={isOffline || !selectedGuest?.email}
                  onClick={handleCardPayment}
                >
                  Card
                </Button>
              </div>
              {!selectedGuest?.email && (
                <p className={formStyles.disabledNotice}>Add an email to this guest to accept card payment.</p>
              )}
              <p className={formStyles.disabledNotice}>
                Or leave it — the balance simply stays owing, to be settled later via Cashiering or at check-out.
              </p>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
