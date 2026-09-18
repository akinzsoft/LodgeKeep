import { useEffect, useRef, useState } from 'react';
import { Card, Button, DataTable, StatusPill } from '../../shared/components/index.js';
import { setupApi, reservationsApi, cashieringApi, groupBlocksApi, ApiError } from '../../shared/api/index.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import { filterRateCodesForStay } from './rate-code-eligibility.js';
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
 * Gap closure (user-reported): a "Phone number" field sits right before
 * the Guest dropdown. `guests` is already the tenant's complete list (the
 * dropdown above is built from it directly), so matching is a plain,
 * synchronous scan of that same array by a normalized (digits-only) phone
 * — no new search endpoint, no network round trip, no staleness/race
 * concern at all. A match auto-selects that guest in the dropdown below;
 * once the typed number is long enough to be a real phone (7+ digits) and
 * genuinely matches nobody, a warning prompt offers to register a new
 * guest, which opens (and scrolls to) the existing "New guest" panel below
 * with the phone pre-filled — reusing that panel as this app's own
 * "register a new guest" flow, since no separate registration screen
 * exists anywhere in this app to navigate to instead.
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
 *
 * Gap closure (user-reported): "the rate code dropdown requires manual
 * selection and shows all rate codes regardless of room type." Checked
 * against the real schema first, not assumed — see `rate-code-eligibility.js`'s
 * own header: rate codes are property-wide, not room-type scoped at all, so
 * there is no room-type filter to apply; the one real filter is the rate
 * code's own `valid_from`/`valid_to` window against the searched dates
 * (`eligibleRateCodes` below). Auto-selecting a default rate code (the
 * request's other half) was NOT built — `rate_codes` has no "default" flag,
 * and picking one by another rule (e.g. first alphabetically) would be
 * inventing a business decision, not implementing one; flagged back to the
 * user rather than guessed.
 *
 * Gap closure (user-reported): "wen Room type is selected it shld show the
 * Rate/cost per night on the Rate code drop box only." Since a rate code is
 * property-wide (above), its own `base_rate` doesn't reflect a per-room-type
 * `rate_calendar` override — `reloadRoomRatesForType`/`describeRatePerNight`
 * resolve the ACTUAL per-night rate for the searched room type (as of the
 * search's arrival date — a real, deliberate simplification: a later night
 * of a multi-night stay CAN carry its own different override this one
 * figure doesn't show) via the same `setupApi.resolveRate` endpoint
 * `RateCodesTab.jsx`'s own calendar panel already uses. "On the Rate code
 * drop box only" — this stays purely a dropdown-option enhancement, not a
 * separate field or summary elsewhere on this screen. Flagged, not fixed
 * here: this reuses the same `setup.view` permission `listRoomTypes`/
 * `listRateCodes` above already require, and SECURITY.md §5's matrix marks
 * Setup `✗` for `front_desk` — the role this screen's own booking flow is
 * for — so this resolve (like the room-type/rate-code lists themselves)
 * degrades to `rc.base_rate` for a front_desk account today, a pre-existing
 * gap this pass didn't introduce and doesn't fix.
 */
export function AvailabilityTab({ activeProperty, isOffline = false } = {}) {
  const [roomTypes, setRoomTypes] = useState(null);
  const [rateCodes, setRateCodes] = useState(null);
  const [guests, setGuests] = useState(null);
  // PLAN.md Phase 4 (Group Blocks) — an optional picker sourced separately
  // from the reference-data trio above, and deliberately soft-failing (see
  // `reloadGroupBlocks` below): a group_blocks.view fetch failure must never
  // block the whole booking form, since a group-block tag is an optional
  // enhancement to booking, not a required field.
  const [groupBlocks, setGroupBlocks] = useState(null);

  const [search, setSearch] = useState({ room_type_id: '', arrival_date: '', departure_date: '' });
  const [availability, setAvailability] = useState(null);
  const [freeRoomsNow, setFreeRoomsNow] = useState(null);
  const [eligiblePreferredRooms, setEligiblePreferredRooms] = useState(null);
  // Gap closure (user-reported): "when Room type is selected it shld show
  // the Rate/cost per night on the Rate code drop box only." `rateCodes`
  // carries only each code's own property-wide `base_rate` — the ACTUAL
  // per-night rate for the room type just searched can differ, via a
  // `rate_calendar` date/room-type override (TESTING.md SET-6: "date
  // override wins over rate-code base rate"). Keyed by rate_code_id (a
  // string, since that's how the <option value> below compares it) ->
  // `{rate, overridden}` from `setupApi.resolveRate`, resolved against the
  // stay's own arrival date — the representative "per night" figure shown
  // in the dropdown, not a per-night breakdown for the whole stay (a real,
  // deliberate simplification: a multi-night stay CAN have a different
  // rate on a later night via its own override, which this one figure
  // doesn't capture — flagged here rather than silently assumed complete).
  const [roomRatesByCode, setRoomRatesByCode] = useState({});
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
    group_block_id: '',
  });
  const [newGuest, setNewGuest] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [addingGuest, setAddingGuest] = useState(false);
  // Gap closure: phone-number guest lookup — see this file's own header.
  const [guestPhone, setGuestPhone] = useState('');
  const [newGuestPanelOpen, setNewGuestPanelOpen] = useState(false);
  const newGuestPanelRef = useRef(null);
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

  async function reloadGroupBlocks() {
    try {
      setGroupBlocks(await groupBlocksApi.listGroupBlocks('active'));
    } catch {
      // Soft-fail: an optional enhancement to booking, never a reason to
      // block the rest of the form — see the state declaration's own note.
      setGroupBlocks([]);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadReferenceData();
    reloadGroupBlocks();
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

  /**
   * Gap closure (user-reported): the Rate code dropdown's own per-night
   * figure — see `roomRatesByCode`'s own state comment for what "per
   * night" means here. One `resolveRate` call per active rate code
   * (there's no single endpoint that resolves every code for a room type
   * at once — `GET /rate-calendar/resolve` is inherently per rate code),
   * run in parallel and never let one code's failure blank the others —
   * `Promise.allSettled`, the same reasoning `reloadFreeRoomsNow`'s own
   * per-widget degradation uses, just per-entry instead of per-widget. A
   * code whose resolve fails (or hasn't resolved yet) simply falls back to
   * its own `base_rate` in the dropdown below — this is a display
   * enhancement, never a reason booking can't proceed.
   */
  async function reloadRoomRatesForType(roomTypeId, arrivalDate) {
    if (!roomTypeId || !arrivalDate) return;
    const codes = rateCodes ?? [];
    const results = await Promise.allSettled(
      codes.map((rc) => setupApi.resolveRate({ rateCodeId: rc.id, roomTypeId, stayDate: arrivalDate }))
    );
    const next = {};
    codes.forEach((rc, index) => {
      const result = results[index];
      if (result.status === 'fulfilled') next[String(rc.id)] = result.value;
    });
    setRoomRatesByCode(next);
  }

  async function handleSearch(event) {
    event.preventDefault();
    setSearching(true);
    setSearchError(null);
    setBookSuccess(null);
    setFreeRoomsNow(null);
    setRoomRatesByCode({});
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
      await reloadRoomRatesForType(search.room_type_id, search.arrival_date);
      // Gap closure (user-reported): the rate code dropdown showed every
      // active property-wide code regardless of the searched dates. A
      // previously-selected code that's no longer valid for THESE dates is
      // cleared here — checked against the freshly-searched dates, not
      // reset unconditionally, so re-running the same search (unchanged
      // dates) keeps a staff member's already-made choice rather than
      // making them reselect it every time. See `eligibleRateCodes`'s own
      // definition below and `rate-code-eligibility.js`'s header for what
      // "valid" means here.
      setBooking((current) => {
        if (!current.rate_code_id) return current;
        const stillEligible = filterRateCodesForStay(rateCodes, search.arrival_date, search.departure_date).some(
          (rc) => String(rc.id) === String(current.rate_code_id)
        );
        return stillEligible ? current : { ...current, rate_code_id: '' };
      });
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
      // Gap closure: the phone-lookup prompt's own reason to be open just
      // resolved — close it rather than leaving it expanded with nothing
      // left to do; `guestPhone` itself stays as typed, which now
      // correctly shows "Guest found" for the guest just created.
      setNewGuestPanelOpen(false);
    } catch (caught) {
      setBookError(caught instanceof ApiError ? caught.message : 'Could not add the guest.');
    } finally {
      setAddingGuest(false);
    }
  }

  // Gap closure: phone-number guest lookup — see this file's own header.
  // A plain digits-only normalization (strips spaces/dashes/parens/plus)
  // so "0801 234 5678" and "08012345678" match the same stored guest.
  const MIN_PHONE_DIGITS = 7;
  function normalizePhone(value) {
    return String(value ?? '').replace(/\D/g, '');
  }
  const normalizedGuestPhone = normalizePhone(guestPhone);
  const phoneMatchedGuest =
    normalizedGuestPhone.length >= MIN_PHONE_DIGITS
      ? (guests ?? []).find((guest) => guest.phone && normalizePhone(guest.phone) === normalizedGuestPhone)
      : null;
  const showPhoneNotFoundPrompt = normalizedGuestPhone.length >= MIN_PHONE_DIGITS && !phoneMatchedGuest;

  function handlePhoneChange(value) {
    setGuestPhone(value);
    const normalized = normalizePhone(value);
    if (normalized.length < MIN_PHONE_DIGITS) return;
    const match = (guests ?? []).find((guest) => guest.phone && normalizePhone(guest.phone) === normalized);
    if (match) setBooking((current) => ({ ...current, guest_id: String(match.id) }));
  }

  /** Pre-fills the phone into the existing "New guest" panel and opens/scrolls to it — this app's own only guest-registration mechanism (see this file's own header). */
  function handleRegisterFromPhone() {
    setNewGuest((current) => ({ ...current, phone: guestPhone }));
    setNewGuestPanelOpen(true);
    window.requestAnimationFrame(() => {
      newGuestPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
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
        ...(booking.group_block_id ? { group_block_id: booking.group_block_id } : {}),
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
      setBooking((current) => ({ ...current, preferred_room_id: '', group_block_id: '' }));
      await reloadEligiblePreferredRooms();
    } catch (caught) {
      setBookError(caught instanceof ApiError ? caught.message : 'Could not create the reservation.');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedGuest = (guests ?? []).find((guest) => String(guest.id) === String(booking.guest_id));
  // Gap closure (user-reported): narrowed to codes valid for this search's
  // own date range — see `rate-code-eligibility.js`'s own header for why
  // there's no room-type narrowing to do (rate codes aren't room-type
  // scoped in this schema at all; every active code applies to every room
  // type). Falls back to the full list rather than leaving nothing
  // selectable when no code's own window covers these exact dates.
  const eligibleRateCodes = filterRateCodesForStay(rateCodes, search.arrival_date, search.departure_date);
  const rateCodesNarrowed = (rateCodes ?? []).length > 0 && eligibleRateCodes.length < (rateCodes ?? []).length;
  /**
   * Gap closure (user-reported): "when Room type is selected it shld show
   * the Rate/cost per night on the Rate code drop box." Prefers the
   * room-type-resolved rate (`roomRatesByCode`, from `reloadRoomRatesForType`)
   * over the code's own generic `base_rate` — falls back to `base_rate`
   * while that resolve is still in flight, or failed (e.g. a role without
   * `setup.view` — see this file's own header on that gap). `overridden`
   * flags a date/room-type-specific rate_calendar row, not the plain base
   * rate, so staff can tell the figure isn't the code's own list price.
   */
  function describeRatePerNight(rateCode) {
    const resolved = roomRatesByCode[String(rateCode.id)];
    return {
      amount: resolved ? resolved.rate : rateCode.base_rate,
      overridden: Boolean(resolved?.overridden),
    };
  }
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
                  min={activeProperty?.current_business_date || undefined}
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
                <span className={formStyles.label}>Phone number</span>
                {/* `type="tel"`, not `type="number"` as literally asked —
                    a real `<input type="number">` strips a leading zero
                    the moment it's typed (confirmed live in this exact
                    change), which would break the overwhelmingly common
                    local phone shape ("0801...") outright. `type="tel"`
                    is the semantically-correct HTML5 type for a phone
                    number anyway and preserves every character exactly as
                    typed; `inputMode="numeric"` still gets a numeric
                    keypad on mobile. */}
                <input
                  type="tel"
                  inputMode="numeric"
                  className={formStyles.input}
                  value={guestPhone}
                  onChange={(event) => handlePhoneChange(event.target.value)}
                  placeholder="Look up a guest by phone"
                />
              </label>
            </div>
            {phoneMatchedGuest && (
              <p className={formStyles.disabledNotice}>
                Guest found — {phoneMatchedGuest.first_name} {phoneMatchedGuest.last_name}. Selected below.
              </p>
            )}
            {showPhoneNotFoundPrompt && (
              <div className={formStyles.phoneLookupPrompt} role="alert">
                <span>No guest found with this phone number.</span>
                <Button type="button" size="compact" variant="secondary" onClick={handleRegisterFromPhone}>
                  Register new guest
                </Button>
              </div>
            )}

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
              {/* A wrapping <label> computes its accessible name from ALL
                  of its text content — see `door-access/SettingsTab.jsx`'s
                  own precedent for this exact fix. The optional narrowing
                  hint below must be a SIBLING of the <label>, not nested
                  inside it, or `getByLabelText('Rate code')` (and a screen
                  reader announcing this field) would pick up the hint text
                  too the moment it renders. */}
              <div className={formStyles.field}>
                <label className={formStyles.label} htmlFor="rate-code-select">
                  Rate code
                </label>
                <select
                  id="rate-code-select"
                  className={formStyles.select}
                  value={booking.rate_code_id}
                  onChange={(event) => setBooking({ ...booking, rate_code_id: event.target.value })}
                  required
                >
                  <option value="" disabled>
                    Select a rate code
                  </option>
                  {eligibleRateCodes.map((rc) => {
                    const { amount, overridden } = describeRatePerNight(rc);
                    return (
                      <option key={rc.id} value={rc.id}>
                        {rc.code} — {amount} {rc.currency}/night{overridden ? ' (room override)' : ''}
                      </option>
                    );
                  })}
                </select>
                {rateCodesNarrowed && (
                  <span className={formStyles.fieldHint}>Narrowed to rate codes valid for these dates.</span>
                )}
              </div>
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
              <label className={formStyles.field}>
                <span className={formStyles.label}>Group block (optional)</span>
                <select
                  className={formStyles.select}
                  value={booking.group_block_id}
                  onChange={(event) => setBooking({ ...booking, group_block_id: event.target.value })}
                >
                  <option value="">Not part of a group</option>
                  {(groupBlocks ?? []).map((block) => (
                    <option key={block.id} value={block.id}>
                      {block.block_name}
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

          <details ref={newGuestPanelRef} open={newGuestPanelOpen} onToggle={(event) => setNewGuestPanelOpen(event.target.open)}>
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
