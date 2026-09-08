'use strict';

/**
 * Reservations + Front Desk service — PLAN.md Phase 2. PRODUCT_REQUIREMENTS.md
 * §3.2/§3.3, ARCHITECTURE.md §5 (last-room race), §11 (the state machine —
 * authoritative for every transition below).
 *
 * ── THE ONE-TRANSACTION RULE ────────────────────────────────────────────
 *
 * Every function that changes state (`createReservation`, `confirmReservation`,
 * `cancelReservation`, `promoteWaitlist`, `markNoShow`, `checkIn`, `checkOut`,
 * `roomMove`) takes `trx` — an ALREADY transaction-bound scoped accessor —
 * rather than opening its own. The controller layer is what opens the one
 * transaction per request, via `src/shared/idempotency.js`'s
 * `withIdempotency`, and hands it down. This keeps the last-room-race lock,
 * the reservation write, and the idempotency-key bookkeeping row all inside
 * one atomic unit, with no nested transactions to reason about. Plain reads
 * (`listReservations`, `getReservation`, `checkAvailability`, the front-desk
 * boards, guest CRUD) take `context` and open their own accessor as normal —
 * Phase 1's pattern, unchanged, since a read needs no transaction.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { writeOutboxEvent } = require('../../shared/outbox');
const {
  livePhysicalCount: sharedLivePhysicalCount,
  listFreeRoomsNow: sharedListFreeRoomsNow,
  outOfOrderRoomIds,
} = require('../../shared/room-availability');
const { generateUlid } = require('../../shared/ulid');
const { resolveRate } = require('../setup/service');
const { postAdjustment: postFolioAdjustment, ensurePrimaryFolio, postRoomChargesForStay } = require('../cashiering/service');
const {
  OverbookingThresholdExceededError,
  RoomUnavailableError,
  RoomNotCleanError,
  RoomOutOfOrderError,
  InvalidReservationTransitionError,
  ArrivalAfterDepartureError,
  FolioBalanceOwingError,
} = require('./errors');

// ---------------------------------------------------------------------
// Pure functions — exported for direct unit testing, no database.
// ---------------------------------------------------------------------

/**
 * Every night of a stay as 'YYYY-MM-DD' strings, arrival inclusive,
 * departure exclusive — the standard hotel convention (a stay
 * 2026-06-01 -> 2026-06-03 is two nights: the 1st and the 2nd).
 */
function expandStayDates(arrivalDate, departureDate) {
  const dates = [];
  const cursor = new Date(`${arrivalDate}T00:00:00Z`);
  const end = new Date(`${departureDate}T00:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * ARCHITECTURE.md §11's graph, plus `waitlisted` (this session's confirmed
 * decision — see the `reservations` migration's own header for why it is
 * not aliased onto `tentative`). Exported and unit-tested directly, the
 * same "the graph is a pure function, not scattered status-string checks"
 * shape Phase 1's `resolveEffectiveTax` established for effective-dating.
 */
const TRANSITIONS = {
  waitlisted: new Set(['confirmed', 'tentative', 'cancelled']),
  tentative: new Set(['confirmed', 'expired', 'cancelled']),
  confirmed: new Set(['checked_in', 'cancelled', 'no_show']),
  checked_in: new Set(['checked_out']),
  checked_out: new Set(),
  cancelled: new Set(),
  no_show: new Set(),
  expired: new Set(),
};

function isValidTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.has(to));
}

/**
 * TESTING.md FD-5/FD-6. Pure — no property-level "scheduled departure time"
 * configuration exists anywhere in this schema yet (PRODUCT_REQUIREMENTS.md
 * §3.3 names it, Phase 1 did not build it), so callers supply the cutoffs
 * explicitly rather than this function reading a config source that does
 * not exist. `scheduledCheckoutTime`/`actualCheckoutTime`/`earlyCutoffTime`
 * are 'HH:MM' 24-hour strings, compared lexically (valid for zero-padded
 * 24h time).
 *
 * @returns {{type: 'early_departure'|'late_checkout', amount: string}|null}
 */
function computeEarlyLateFee({
  scheduledCheckoutTime,
  actualCheckoutTime,
  earlyCutoffTime,
  earlyDepartureFee = '0.00',
  lateCheckoutFee = '0.00',
}) {
  if (earlyCutoffTime && actualCheckoutTime < earlyCutoffTime) {
    return { type: 'early_departure', amount: earlyDepartureFee };
  }
  if (scheduledCheckoutTime && actualCheckoutTime > scheduledCheckoutTime) {
    return { type: 'late_checkout', amount: lateCheckoutFee };
  }
  return null;
}

// ---------------------------------------------------------------------
// Outbox events (PLAN.md Phase 3, ARCHITECTURE.md §13) — the notifications
// module's own dispatcher reads these; this module only ever writes them,
// in the same transaction as the state change they describe.
// ---------------------------------------------------------------------

/**
 * One helper for all four wired events (`reservation.confirmed`,
 * `reservation.cancelled`, `guest.checked_in`, `guest.checked_out`) — same
 * guest/reservation payload shape every time, since
 * `src/modules/notifications/service.js`'s template substitution reads the
 * same variable names regardless of which event fired. A reservation with
 * no email on file (the `guests` stub's `email` column is nullable) simply
 * produces no dispatchable event — the notifications dispatcher's own
 * `dispatchOne` already treats a missing `guestEmail` as "nothing to send,"
 * so this never blocks the reservation mutation itself on the guest having
 * an email address.
 */
async function emitReservationEvent({ trx, eventType, reservation, extra }) {
  const guest = await trx.table('guests').where({ id: reservation.guest_id }).first();
  await writeOutboxEvent({
    trx,
    eventType,
    aggregateType: 'reservations',
    aggregateId: reservation.id,
    propertyId: reservation.property_id,
    payload: {
      reservationId: reservation.id,
      guestEmail: guest?.email ?? null,
      guestName: guest ? `${guest.first_name} ${guest.last_name}` : null,
      confirmationNumber: reservation.confirmation_number,
      arrivalDate: reservation.arrival_date,
      departureDate: reservation.departure_date,
      ...extra,
    },
  });
}

// ---------------------------------------------------------------------
// Guests — minimal stub (this session's confirmed decision; see the
// `guests` migration's own header for full scope reasoning).
// ---------------------------------------------------------------------

async function createGuest({ context, firstName, lastName, email, phone }) {
  const db = scopedDb().for(context);
  const [id] = await db.table('guests').insert({
    first_name: firstName,
    last_name: lastName,
    email: email ?? null,
    phone: phone ?? null,
  });
  return getGuest({ context, id });
}

async function getGuest({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('guests').where({ id }).first();
}

/**
 * Gap closure (user-reported): "num of active and inactive customer ...
 * click to see active or inactive customers." Confirmed with the user
 * before building — `guests.status` (active/merged/anonymised) is a GDPR
 * record-lifecycle flag, not a customer-activity concept, and nothing in
 * this codebase ever writes `merged`/`anonymised`, so every guest is
 * "active" by that field alone; a report built on it would always read
 * 100%/0%. "Active" here means something real instead: at least one
 * reservation (any status) with an arrival date in the last 12 months.
 * Pure — exported for direct unit testing, no clock mocking needed at the
 * DB layer — `now` defaults to the real clock but is overridable for tests.
 */
function activityCutoffDate(now = new Date()) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Every guest id with at least one reservation arriving on/after the
 * 12-month cutoff above — deliberately no upper bound, so a guest with a
 * reservation arriving next month or next year counts as active too, not
 * only one arriving in the past 12 months. Excluding a guest with a real
 * upcoming stay from "active" would be a worse report than the one this
 * closes, even though it reads narrower than the literal "last 12 months"
 * phrasing. `acrossProperties()` since a guest (TENANT_SCOPED) can have
 * stays at more than one property, the same reasoning `getGuestStayHistory`
 * (`profiles/service.js`) already uses for its own tenant-wide read. Shared
 * by `listGuests`'s own `activity` filter below and `profiles/service.js`'s
 * `getGuestActivitySummary` (a cross-module service-to-service call, the
 * same shape that file's own `getGuest` re-export already establishes).
 */
async function getActiveGuestIds({ context }) {
  const db = scopedDb().for(context);
  const rows = await db.acrossProperties().table('reservations').where('arrival_date', '>=', activityCutoffDate()).select('guest_id');
  return new Set(rows.map((r) => String(r.guest_id)));
}

/** @param {'active'|'inactive'} [activity] Optional — omitted returns every active-status guest, unfiltered by activity (the original Phase 2 behaviour). */
async function listGuests({ context, activity }) {
  const db = scopedDb().for(context);
  const guests = await db.table('guests').where({ status: 'active' }).orderBy('last_name');
  if (activity !== 'active' && activity !== 'inactive') return guests;

  const activeIds = await getActiveGuestIds({ context });
  return guests.filter((guest) => activeIds.has(String(guest.id)) === (activity === 'active'));
}

// ---------------------------------------------------------------------
// Availability & the last-room race (ARCHITECTURE.md §5)
// ---------------------------------------------------------------------

/**
 * Live physical count for one room type on one stay date — PLAN.md Phase 3
 * moved this into `src/shared/room-availability.js` so the reporting
 * module's occupancy figures use the exact same live exclusions
 * (out-of-order periods, discrepant rooms) rather than a second
 * reimplementation drifting from this one. See that file's own header for
 * the full reasoning; this is a thin re-export so every existing call site
 * in this file (`roomTypeId` always supplied here) keeps working unchanged.
 */
async function livePhysicalCount({ db, roomTypeId, stayDate }) {
  return sharedLivePhysicalCount({ db, roomTypeId, stayDate });
}

async function ensureInventoryRow({ trx, roomTypeId, stayDate }) {
  try {
    await trx.table('room_type_inventory').insert({ room_type_id: roomTypeId, stay_date: stayDate, rooms_sold: 0 });
  } catch (error) {
    if (!(error && error.code === 'ER_DUP_ENTRY')) throw error;
  }
}

/**
 * ARCHITECTURE.md §5's last-room race, applied once per night of the stay,
 * all inside the caller's transaction: insert-if-missing, then
 * `SELECT ... FOR UPDATE` the row, then check-and-increment atomically. A
 * failure on any single night aborts the whole transaction — no partial
 * hold across some-but-not-all nights (TESTING.md RES-5's "no partial write").
 */
async function reserveInventoryForDates({ trx, roomTypeId, stayDates }) {
  for (const stayDate of stayDates) {
    await ensureInventoryRow({ trx, roomTypeId, stayDate });

    const row = await trx.table('room_type_inventory').where({ room_type_id: roomTypeId, stay_date: stayDate }).forUpdate().first();

    const physicalCount = await livePhysicalCount({ db: trx, roomTypeId, stayDate });
    const threshold = Math.floor((physicalCount * Number(row.overbooking_threshold_pct)) / 100);
    if (row.rooms_sold + 1 > threshold) {
      throw new OverbookingThresholdExceededError(roomTypeId, stayDate);
    }

    await trx.table('room_type_inventory').where({ id: row.id }).update({ rooms_sold: row.rooms_sold + 1 });
  }
}

/** The inverse of `reserveInventoryForDates` — cancellation and no-show release. Never goes below zero. */
async function releaseInventoryForDates({ trx, roomTypeId, stayDates }) {
  for (const stayDate of stayDates) {

    const row = await trx.table('room_type_inventory').where({ room_type_id: roomTypeId, stay_date: stayDate }).forUpdate().first();
    if (!row) continue;

    await trx.table('room_type_inventory').where({ id: row.id }).update({ rooms_sold: Math.max(0, row.rooms_sold - 1) });
  }
}

/**
 * Read-only availability search (PRODUCT_REQUIREMENTS.md §3.2) — no lock, a
 * point-in-time answer that createReservation re-verifies for real under
 * lock. Physical count is computed per NIGHT, not once for the whole stay
 * (PLAN.md Phase 3): a room can be out-of-order for only part of a
 * requested range, so a stay spanning an OOO window must see fewer sellable
 * rooms on those specific nights, not the whole range.
 */
async function checkAvailability({ context, roomTypeId, arrivalDate, departureDate }) {
  const db = scopedDb().for(context);
  const stayDates = expandStayDates(arrivalDate, departureDate);

  const rows = await db
    .table('room_type_inventory')
    .where({ room_type_id: roomTypeId })
    .whereIn('stay_date', stayDates);
  const rowByDate = new Map(rows.map((r) => [String(r.stay_date), r]));

  const nights = [];
  for (const stayDate of stayDates) {
    const physicalCount = await livePhysicalCount({ db, roomTypeId, stayDate });
    const row = rowByDate.get(stayDate);
    const thresholdPct = row ? Number(row.overbooking_threshold_pct) : 100;
    const roomsSold = row ? row.rooms_sold : 0;
    const threshold = Math.floor((physicalCount * thresholdPct) / 100);
    nights.push({ stayDate, physicalCount, roomsSold, threshold, sellable: Math.max(0, threshold - roomsSold) });
  }

  return { roomTypeId, nights, minSellable: Math.min(...nights.map((n) => n.sellable)) };
}

/**
 * PLAN.md Phase 3: the one real gap left in an otherwise fully-wired
 * overbooking mechanism — `overbooking_threshold_pct` (Phase 2) had no
 * endpoint to actually set it, only ever taking its `100.00` schema default.
 * PRODUCT_REQUIREMENTS.md §3.2's own example ("sell up to 102% of physical
 * inventory") is meaningless without a way to configure the 102. Lazily
 * creates the (room_type, date) row exactly like `ensureInventoryRow` does,
 * since a manager may want to raise the threshold for a date with no
 * bookings against it yet.
 */
async function configureOverbookingThreshold({ context, roomTypeId, stayDate, overbookingThresholdPct }) {
  const db = scopedDb().for(context);
  try {
    await db.table('room_type_inventory').insert({ room_type_id: roomTypeId, stay_date: stayDate, rooms_sold: 0, overbooking_threshold_pct: overbookingThresholdPct });
  } catch (error) {
    if (!(error && error.code === 'ER_DUP_ENTRY')) throw error;
    await db.table('room_type_inventory').where({ room_type_id: roomTypeId, stay_date: stayDate }).update({ overbooking_threshold_pct: overbookingThresholdPct });
  }
  return db.table('room_type_inventory').where({ room_type_id: roomTypeId, stay_date: stayDate }).first();
}

// ---------------------------------------------------------------------
// Reservations — creation and the ARCHITECTURE.md §11 state machine
// ---------------------------------------------------------------------

/**
 * TESTING.md RES-1..RES-10. `asHold` books a `tentative` hold instead of a
 * firm `confirmed` reservation (§11: "a direct booking or a staff-entered
 * confirmed reservation can skip straight to CONFIRMED" — the default here
 * is that skip, `asHold` opts into the hold instead). `allowWaitlist`, when
 * the requested dates have no sellable inventory, creates a `waitlisted`
 * reservation instead of failing outright — no inventory is held for a
 * waitlisted reservation (see `promoteWaitlist`, which is what actually
 * acquires it later).
 */
async function createReservation({
  trx,
  guestId,
  roomTypeId,
  rateCodeId,
  arrivalDate,
  departureDate,
  adults,
  children,
  asHold,
  allowWaitlist,
  marketSegmentId,
  bookingSourceId,
  cancellationPolicyId,
  preferredRoomId,
}) {
  if (!(departureDate > arrivalDate)) {
    throw new ArrivalAfterDepartureError();
  }
  const stayDates = expandStayDates(arrivalDate, departureDate);

  const rateCode = await trx.table('rate_codes').where({ id: rateCodeId }).first();
  if (!rateCode) {
    throw new ValidationError('RATE_CODE_NOT_FOUND', 'The specified rate code does not exist at this property.');
  }

  // All three are optional (PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md
  // §3.19) — a friendly existence check here, same reasoning as rate_code_id
  // above, rather than surfacing a raw FK-violation error to the caller.
  if (marketSegmentId != null && !(await trx.table('market_segments').where({ id: marketSegmentId }).first())) {
    throw new ValidationError('MARKET_SEGMENT_NOT_FOUND', 'The specified market segment does not exist at this property.');
  }
  if (bookingSourceId != null && !(await trx.table('booking_sources').where({ id: bookingSourceId }).first())) {
    throw new ValidationError('BOOKING_SOURCE_NOT_FOUND', 'The specified booking source does not exist at this property.');
  }
  if (
    cancellationPolicyId != null &&
    !(await trx.table('cancellation_policies').where({ id: cancellationPolicyId }).first())
  ) {
    throw new ValidationError(
      'CANCELLATION_POLICY_NOT_FOUND',
      'The specified cancellation policy does not exist at this property.'
    );
  }

  // Gap closure: a guest-requested room number, stored as a REQUEST, never a
  // lock — see `checkIn`, which still accepts any `roomId` unmodified.
  // Validated the same friendly way as rate_code_id/market_segment_id above
  // (existence, then a same-room-type sanity check) rather than surfacing a
  // raw FK-violation error — but deliberately NOT checked against current
  // occupancy: a preference for a future date can't be, and shouldn't be,
  // gated on who happens to be in that room today.
  if (preferredRoomId != null) {
    const preferredRoom = await trx.table('rooms').where({ id: preferredRoomId }).first();
    if (!preferredRoom) {
      throw new ValidationError('PREFERRED_ROOM_NOT_FOUND', 'The specified preferred room does not exist at this property.');
    }
    if (String(preferredRoom.room_type_id) !== String(roomTypeId)) {
      throw new ValidationError('PREFERRED_ROOM_TYPE_MISMATCH', 'The specified preferred room does not belong to the requested room type.');
    }
  }

  let status = asHold ? 'tentative' : 'confirmed';
  try {
    await reserveInventoryForDates({ trx, roomTypeId, stayDates });
  } catch (error) {
    if (error instanceof OverbookingThresholdExceededError && allowWaitlist) {
      status = 'waitlisted';
    } else {
      throw error;
    }
  }

  const [id] = await trx.table('reservations').insert({
    guest_id: guestId,
    room_type_id: roomTypeId,
    rate_code_id: rateCodeId,
    arrival_date: arrivalDate,
    departure_date: departureDate,
    adults: adults ?? 1,
    children: children ?? 0,
    status,
    confirmation_number: generateUlid(),
    market_segment_id: marketSegmentId ?? null,
    booking_source_id: bookingSourceId ?? null,
    cancellation_policy_id: cancellationPolicyId ?? null,
    preferred_room_id: preferredRoomId ?? null,
  });

  // TESTING.md RES-7/RES-8: resolve and snapshot the rate for every night
  // NOW — a later rate-code or rate-calendar change must never alter it.
  const overrides = await trx
    .table('rate_calendar')
    .where({ rate_code_id: rateCodeId, room_type_id: roomTypeId })
    .whereIn('stay_date', stayDates);
  const overrideByDate = new Map(overrides.map((o) => [String(o.stay_date), o]));

  await trx.table('reservation_daily_rates').insert(
    stayDates.map((stayDate) => ({
      reservation_id: id,
      stay_date: stayDate,
      rate: resolveRate(rateCode, overrideByDate.get(stayDate)),
      currency: rateCode.currency,
    }))
  );

  const created = await trx.table('reservations').where({ id }).first();
  // PLAN.md Phase 3: only a reservation that actually LANDS on `confirmed`
  // (the default, non-hold, non-waitlisted path) emits the confirmation
  // email — a tentative hold or a waitlisted booking has nothing to confirm
  // yet (`confirmReservation`/`promoteWaitlist` emit it themselves when
  // those DO transition to confirmed).
  if (created.status === 'confirmed') {
    await emitReservationEvent({ trx, eventType: 'reservation.confirmed', reservation: created });
  }
  return created;
}

/**
 * Gap closure (user-reported): "if the customer wants to pay at the point
 * of booking" — opens the reservation's primary folio and posts every
 * night's room charge immediately, WITHOUT waiting for check-in, so front
 * desk can offer real cash/card payment right there on the booking screen.
 * Deliberately NOT the guest portal's own `createBookingWithPayment` shape
 * (`portal/service.js`) — that flow books as a `tentative` hold and
 * cancels the whole reservation if payment is never completed; a staff
 * booking made over the phone or in person stays `confirmed` regardless of
 * whether payment happens now, later, or never (an unpaid balance is a
 * normal, expected outcome here, not a failure to roll back — confirmed
 * with the user before building this). Only a `confirmed` reservation may
 * have its folio opened this way — a `waitlisted` reservation holds no
 * room to bill, and a `tentative` hold's own fate is still undecided.
 *
 * Idempotent and safe to call more than once for the same reservation:
 * `ensurePrimaryFolio` reuses an existing folio rather than opening a
 * second one, and `postRoomChargesForStay`'s own per-business_date guard
 * skips a night already posted — reopening the booking screen (or a
 * network retry) never double-bills.
 */
async function openBookingFolio({ trx, id }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (reservation.status !== 'confirmed') {
    throw new ValidationError(
      'RESERVATION_NOT_CONFIRMED',
      'Only a confirmed reservation can have its folio opened for payment.'
    );
  }
  const folio = await ensurePrimaryFolio({ trx, reservationId: id });
  return postRoomChargesForStay({ trx, reservationId: id, folioId: folio.id });
}

/** `tentative` -> `confirmed`. No inventory change: a tentative hold already counts against sellable inventory (§11). */
async function confirmReservation({ trx, id }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (!isValidTransition(reservation.status, 'confirmed')) {
    throw new InvalidReservationTransitionError(reservation.status, 'confirmed');
  }
  await trx.table('reservations').where({ id }).update({ status: 'confirmed' });
  const updated = await trx.table('reservations').where({ id }).first();
  await emitReservationEvent({ trx, eventType: 'reservation.confirmed', reservation: updated });
  return updated;
}

/** `waitlisted` -> `confirmed`, acquiring the inventory a waitlisted reservation never held. Throws `OverbookingThresholdExceededError` again if still nothing free — the reservation stays waitlisted. */
async function promoteWaitlist({ trx, id }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (!isValidTransition(reservation.status, 'confirmed')) {
    throw new InvalidReservationTransitionError(reservation.status, 'confirmed');
  }
  const stayDates = expandStayDates(reservation.arrival_date, reservation.departure_date);
  await reserveInventoryForDates({ trx, roomTypeId: reservation.room_type_id, stayDates });
  await trx.table('reservations').where({ id }).update({ status: 'confirmed' });
  const updated = await trx.table('reservations').where({ id }).first();
  await emitReservationEvent({ trx, eventType: 'reservation.confirmed', reservation: updated });
  return updated;
}

/** TESTING.md RES-10. Releases inventory unless the reservation was `waitlisted` (which never held any). */
async function cancelReservation({ trx, id, reason }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (!isValidTransition(reservation.status, 'cancelled')) {
    throw new InvalidReservationTransitionError(reservation.status, 'cancelled');
  }
  if (reservation.status !== 'waitlisted') {
    const stayDates = expandStayDates(reservation.arrival_date, reservation.departure_date);
    await releaseInventoryForDates({ trx, roomTypeId: reservation.room_type_id, stayDates });
  }
  await trx.table('reservations').where({ id }).update({
    status: 'cancelled',
    cancelled_at: new Date(),
    cancellation_reason: reason ?? null,
  });
  const updated = await trx.table('reservations').where({ id }).first();
  await emitReservationEvent({ trx, eventType: 'reservation.cancelled', reservation: updated });
  return updated;
}

/**
 * `confirmed` -> `no_show`. Releases inventory immediately — §11 allows
 * "released (or retained for no-show fee period, per property config)"; no
 * such config exists in this pass, so immediate release is the simpler of
 * the two documented options, flagged rather than silently assumed.
 */
async function markNoShow({ trx, id }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (!isValidTransition(reservation.status, 'no_show')) {
    throw new InvalidReservationTransitionError(reservation.status, 'no_show');
  }
  const stayDates = expandStayDates(reservation.arrival_date, reservation.departure_date);
  await releaseInventoryForDates({ trx, roomTypeId: reservation.room_type_id, stayDates });
  await trx.table('reservations').where({ id }).update({ status: 'no_show' });
  return trx.table('reservations').where({ id }).first();
}

// ---------------------------------------------------------------------
// Front desk — check-in, check-out, room move (TESTING.md FD-1..FD-7)
// ---------------------------------------------------------------------

/**
 * TESTING.md FD-1/FD-2. `roomId` is not required to match the reservation's
 * booked room TYPE — PRODUCT_REQUIREMENTS.md §3.3 lists upgrades as a
 * front-desk action, so a different (typically higher) room type is
 * accepted without a separate "upgrade" endpoint; rate implications of an
 * upgrade are Cashiering territory, out of this pass's scope.
 *
 * FD-2: a room housekeeping has not marked `clean` blocks check-in outright
 * (§11's "blocked or warned per configuration" — no per-property config
 * exists yet, so blocked is the simpler documented option). `overrideDirty`
 * lets front desk explicitly proceed anyway — a real front desk sometimes
 * must (a guest waiting, housekeeping running behind) — and is itself
 * audited via the normal audit-trail path every check-in already goes
 * through, so an override is visible, not silent.
 */
async function checkIn({ trx, id, roomId, overrideDirty }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (!isValidTransition(reservation.status, 'checked_in')) {
    throw new InvalidReservationTransitionError(reservation.status, 'checked_in');
  }

  const room = await trx.table('rooms').where({ id: roomId }).first();
  if (!room) {
    throw new ValidationError('ROOM_NOT_FOUND', 'The specified room does not exist at this property.');
  }
  if (room.housekeeping_reported_status !== 'clean' && !overrideDirty) {
    throw new RoomNotCleanError(roomId);
  }

  // PLAN.md Phase 3: a room out-of-order/out-of-service or carrying an
  // unresolved discrepancy cannot be checked into, and — unlike the dirty
  // check above — has no override: it needs the OOO period closed or the
  // discrepancy resolved first (housekeeping's own action), not a front-desk
  // checkbox at the moment of check-in.
  if (room.has_discrepancy) {
    throw new RoomOutOfOrderError(roomId);
  }
  const property = await trx.table('properties').where({ id: reservation.property_id }).first();
  const businessDate = property?.current_business_date;
  if (businessDate) {
    const activeOoo = await trx
      .table('out_of_order_periods')
      .where({ room_id: roomId })
      .where('start_date', '<=', businessDate)
      .where('end_date', '>=', businessDate)
      .first();
    if (activeOoo) {
      throw new RoomOutOfOrderError(roomId);
    }
  }

  const occupied = await trx.table('reservation_rooms').where({ room_id: roomId, effective_to: null }).first();
  if (occupied) {
    throw new RoomUnavailableError(roomId);
  }

  const now = new Date();
  await trx.table('reservation_rooms').insert({ reservation_id: id, room_id: roomId, effective_from: now, effective_to: null });

  // PLAN.md Phase 4: reused rather than inserted directly — a portal
  // booking (src/modules/portal) can already have opened this reservation's
  // primary folio before arrival, and this must reuse that one, never
  // create a silent second folio the same reservation's own payment and
  // charges are then split across (cashiering/service.js's own header on
  // `ensurePrimaryFolio` has the full reasoning).
  await ensurePrimaryFolio({ trx, reservationId: id });

  // PLAN.md Phase 3: check-in now actually maintains `rooms.front_desk_status`
  // (Phase 2 never wrote to this column at all — see the housekeeping
  // module's own notes for why that mattered).
  await trx.table('rooms').where({ id: roomId }).update({ front_desk_status: 'occupied' });

  await trx.table('reservations').where({ id }).update({ status: 'checked_in', checked_in_at: now });
  const updated = await trx.table('reservations').where({ id }).first();
  await emitReservationEvent({ trx, eventType: 'guest.checked_in', reservation: updated, extra: { roomNumber: room.room_number } });
  return updated;
}

/**
 * TESTING.md FD-4/FD-5/FD-6. The folio balance must be zero going INTO
 * checkout (§11's literal precondition) — always true in this pass since
 * nothing posts a charge outside a test fixture setting the balance
 * directly to exercise FD-4's guard. Any early/late fee is now a REAL
 * `folio_line_items` adjustment (PLAN.md Phase 2.5's real ledger,
 * `src/modules/cashiering/service.js`'s `postAdjustment` — a cross-module
 * service call, per CLAUDE.md's module-boundary rule), posted as part of
 * THIS same checkout — not blocked on: Cashiering can capture a payment
 * for it separately, but checkout itself still completes with the fee
 * left owing, exactly as Phase 2/3 already flagged, now backed by a real,
 * voidable, auditable ledger line instead of an opaque overwritten number.
 *

 * PLAN.md Phase 3: `scheduledCheckoutTime`/`earlyCutoffTime`/the two fee
 * amounts now default to the property's own configured checkout policy
 * (`properties.scheduled_checkout_time` etc., this pass's migration) when
 * the caller does not supply them explicitly — closing the gap
 * `computeEarlyLateFee`'s own comment has flagged since Phase 2. A caller
 * that still passes them explicitly (e.g. a one-off manager exception)
 * overrides the property default, never the other way round.
 * `actualCheckoutTime` has no property-level default by definition — it is
 * always the caller's own report of when checkout actually happened.
 */
async function checkOut({ trx, id, scheduledCheckoutTime, actualCheckoutTime, earlyCutoffTime, earlyDepartureFee, lateCheckoutFee, userId }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (!isValidTransition(reservation.status, 'checked_out')) {
    throw new InvalidReservationTransitionError(reservation.status, 'checked_out');
  }

  const folio = await trx.table('folios').where({ reservation_id: id, status: 'open' }).first();
  if (!folio) {
    throw new ValidationError('FOLIO_NOT_FOUND', 'No open folio for this reservation.');
  }
  if (Number(folio.balance) !== 0) {
    throw new FolioBalanceOwingError(folio.balance);
  }

  const property = await trx.table('properties').where({ id: reservation.property_id }).first();
  // MySQL's TIME columns come back as 'HH:MM:SS' — truncated to 'HH:MM' so
  // they compare consistently against `actualCheckoutTime`'s own 'HH:MM'
  // format (`computeEarlyLateFee`'s own doc: "valid for zero-padded 24h
  // time", which assumes one consistent width on both sides).
  const toHHMM = (value) => (typeof value === 'string' ? value.slice(0, 5) : value);
  const effectiveScheduled = scheduledCheckoutTime ?? toHHMM(property?.scheduled_checkout_time) ?? undefined;
  const effectiveEarlyCutoff = earlyCutoffTime ?? toHHMM(property?.early_checkout_cutoff_time) ?? undefined;
  const effectiveEarlyFee = earlyDepartureFee ?? property?.early_departure_fee ?? '0.00';
  const effectiveLateFee = lateCheckoutFee ?? property?.late_checkout_fee ?? '0.00';

  let fee = null;
  if (effectiveScheduled && actualCheckoutTime) {
    fee = computeEarlyLateFee({
      scheduledCheckoutTime: effectiveScheduled,
      actualCheckoutTime,
      earlyCutoffTime: effectiveEarlyCutoff,
      earlyDepartureFee: effectiveEarlyFee,
      lateCheckoutFee: effectiveLateFee,
    });
  }
  if (fee && Number(fee.amount) !== 0) {
    await postFolioAdjustment({
      trx,
      folioId: folio.id,
      description: fee.type === 'early_departure' ? 'Early departure fee' : 'Late checkout fee',
      amount: fee.amount,
      // Falls back to the reservation's own departure_date when the
      // property has no current_business_date set yet (Phase 1's own
      // "not every fixture/property needs one" reasoning) — a checkout fee
      // always has a real calendar day it happened on regardless of
      // whether business-date rollover (Night Audit) has been exercised.
      businessDate: property?.current_business_date ?? reservation.departure_date,
      userId: userId ?? null,
      reason: fee.type === 'early_departure' ? 'Early departure fee applied at checkout.' : 'Late checkout fee applied at checkout.',
    });
  }

  const now = new Date();
  await trx.table('folios').where({ id: folio.id }).update({ status: 'closed', closed_at: now });
  const finalBalance = (await trx.table('folios').where({ id: folio.id }).first()).balance;

  const assignment = await trx.table('reservation_rooms').where({ reservation_id: id, effective_to: null }).first();
  await trx.table('reservation_rooms').where({ reservation_id: id, effective_to: null }).update({ effective_to: now });

  // PLAN.md Phase 3: check-out now actually maintains `rooms.front_desk_status`
  // (Phase 2 never wrote to this column — see `checkIn`'s own comment).
  // The room also needs a fresh housekeeping pass — marked `dirty` and its
  // last occupancy observation cleared, since the housekeeper has not yet
  // physically inspected it since this guest left (PRODUCT_REQUIREMENTS.md
  // section 3.6's discrepancy check compares against a CURRENT observation,
  // not a stale one from before this stay).
  if (assignment) {
    await trx.table('rooms').where({ id: assignment.room_id }).update({
      front_desk_status: 'vacant',
      housekeeping_reported_status: 'dirty',
      housekeeping_occupancy_observed: null,
    });
  }

  await trx.table('reservations').where({ id }).update({ status: 'checked_out', checked_out_at: now });
  const updated = await trx.table('reservations').where({ id }).first();
  await emitReservationEvent({ trx, eventType: 'guest.checked_out', reservation: updated, extra: { folioBalance: finalBalance } });

  return { reservation: updated, fee };
}

/**
 * TESTING.md FD-3. Closes the current assignment and opens a new one —
 * `reservation_rooms` keeps both rows, never overwritten.
 *
 * PLAN.md Phase 3: the destination room gets the same out-of-order/
 * discrepancy guard `checkIn` does — a move is, from the room's point of
 * view, a fresh check-in. Both rooms' `front_desk_status` are now actually
 * maintained (Phase 2 never wrote to this column at all): the vacated room
 * goes back to `vacant` and, since it now needs cleaning before it can be
 * sold again, `dirty` — the same state check-out itself leaves a room in.
 */
async function roomMove({ trx, id, newRoomId, reason }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (reservation.status !== 'checked_in') {
    throw new ValidationError('NOT_CHECKED_IN', 'A room move requires the reservation to be checked in.');
  }

  const newRoom = await trx.table('rooms').where({ id: newRoomId }).first();
  if (!newRoom) {
    throw new ValidationError('ROOM_NOT_FOUND', 'The specified room does not exist at this property.');
  }
  if (newRoom.has_discrepancy) {
    throw new RoomOutOfOrderError(newRoomId);
  }

  const occupied = await trx.table('reservation_rooms').where({ room_id: newRoomId, effective_to: null }).first();
  if (occupied) {
    throw new RoomUnavailableError(newRoomId);
  }

  const currentAssignment = await trx.table('reservation_rooms').where({ reservation_id: id, effective_to: null }).first();

  const now = new Date();
  await trx.table('reservation_rooms').where({ reservation_id: id, effective_to: null }).update({ effective_to: now });
  await trx.table('reservation_rooms').insert({ reservation_id: id, room_id: newRoomId, effective_from: now, effective_to: null, reason: reason ?? null });

  if (currentAssignment) {
    await trx.table('rooms').where({ id: currentAssignment.room_id }).update({
      front_desk_status: 'vacant',
      housekeeping_reported_status: 'dirty',
      housekeeping_occupancy_observed: null,
    });
  }
  await trx.table('rooms').where({ id: newRoomId }).update({ front_desk_status: 'occupied' });

  return trx.table('reservation_rooms').where({ reservation_id: id, effective_to: null }).first();
}

/**
 * Gap closure (user-reported): a guest still checked in past their booked
 * departure date was never billed for the extra night(s) — Night Audit's
 * own room-charge step only posts a charge for a night that already has a
 * `reservation_daily_rates` row, fixed at booking time to the ORIGINAL
 * arrival/departure range (`createReservation`'s own header). Confirmed
 * with the user rather than assumed: extending a stay is a deliberate
 * front-desk decision, never something Night Audit should infer and bill
 * on its own — so this is a new, explicit transition, not a change to
 * Night Audit itself, which keeps billing exactly whatever
 * `reservation_daily_rates` says, unchanged.
 *
 * Reuses the exact same last-room-race mechanism `createReservation`
 * already uses (`reserveInventoryForDates`), but only for the NEW nights
 * (the current departure date up to the new one) — extending a stay
 * competes for the same room-type inventory a fresh booking for those
 * dates would, and is rejected the same `OverbookingThresholdExceededError`
 * way if none is left; the guest's own already-assigned physical room
 * needs no separate availability check, since a room is never assigned to
 * a future reservation before ITS OWN check-in (Phase 2's confirmed
 * decision) — nothing else could be holding this specific room for those
 * dates. `reservation_daily_rates` gets one new row per added night, its
 * rate resolved through the same `resolveRate`/`rate_calendar` snapshot
 * `createReservation` uses — the nights already posted/billed are never
 * touched. Requires `checked_in` (an overstay is, by definition, a guest
 * already in the building — this is not how a still-`confirmed` future
 * reservation's dates get changed, which remains the flagged
 * `PATCH /reservations/:id` gap). Night Audit bills the added night(s)
 * exactly like any other booked night, the next time it runs — this
 * function itself posts no charge.
 */
async function extendStay({ trx, id, newDepartureDate }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (reservation.status !== 'checked_in') {
    throw new ValidationError('NOT_CHECKED_IN', 'Only a checked-in reservation can have its stay extended.');
  }
  if (!(newDepartureDate > reservation.departure_date)) {
    throw new ValidationError(
      'EXTENSION_NOT_AFTER_CURRENT_DEPARTURE',
      'The new departure date must be after the current departure date.'
    );
  }

  const addedStayDates = expandStayDates(reservation.departure_date, newDepartureDate);
  await reserveInventoryForDates({ trx, roomTypeId: reservation.room_type_id, stayDates: addedStayDates });

  const rateCode = await trx.table('rate_codes').where({ id: reservation.rate_code_id }).first();
  const overrides = await trx
    .table('rate_calendar')
    .where({ rate_code_id: reservation.rate_code_id, room_type_id: reservation.room_type_id })
    .whereIn('stay_date', addedStayDates);
  const overrideByDate = new Map(overrides.map((o) => [String(o.stay_date), o]));

  await trx.table('reservation_daily_rates').insert(
    addedStayDates.map((stayDate) => ({
      reservation_id: id,
      stay_date: stayDate,
      rate: resolveRate(rateCode, overrideByDate.get(stayDate)),
      currency: rateCode.currency,
    }))
  );

  await trx.table('reservations').where({ id }).update({ departure_date: newDepartureDate });
  return trx.table('reservations').where({ id }).first();
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

async function getReservation({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('reservations').where({ id }).first();
}

/** Allow-listed filters only (API.md's own rule): status, arrival date range, room type. */
async function listReservations({ context, status, arrivalDateFrom, arrivalDateTo, roomTypeId }) {
  const db = scopedDb().for(context);
  let query = db.table('reservations');
  if (status) query = query.where({ status });
  if (roomTypeId) query = query.where({ room_type_id: roomTypeId });
  if (arrivalDateFrom && arrivalDateTo) query = query.whereBetween('arrival_date', [arrivalDateFrom, arrivalDateTo]);
  return query.orderBy('arrival_date');
}

async function listWaitlist({ context }) {
  const db = scopedDb().for(context);
  return db.table('reservations').where({ status: 'waitlisted' }).orderBy('created_at');
}

async function addNote({ context, reservationId, userId, note }) {
  const db = scopedDb().for(context);
  const [id] = await db.table('reservation_notes').insert({ reservation_id: reservationId, user_id: userId, note });
  return db.table('reservation_notes').where({ id }).first();
}

async function listNotes({ context, reservationId }) {
  const db = scopedDb().for(context);
  return db.table('reservation_notes').where({ reservation_id: reservationId }).orderBy('created_at', 'desc');
}

/** Uses the property's own business date (ARCHITECTURE.md §6), never wall-clock. */
async function propertyBusinessDate({ context }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').where({ id: context.propertyId }).first();
  return property?.current_business_date ?? null;
}

/**
 * Gap closure (user-reported): PRODUCT_REQUIREMENTS.md §3.3 names "guest
 * name, room, rate, folio balance, status pill" for these three boards —
 * this pass closes the guest-name/phone half of that gap (room/rate/folio
 * balance remain a separate, not-yet-built follow-on). `guests` is
 * TENANT_SCOPED (`table-scopes.js`), so the join goes through the scoped
 * accessor's own `joinScoped`, not a bare `.join()` — the same mechanism
 * `findInHouseForCharge` (PLAN.md Phase 4 POS) already established for a
 * reservations→guests join.
 */
function selectReservationWithGuest(query) {
  return query
    .joinScoped('guests', (join) => join.on('guests.id', '=', 'reservations.guest_id'))
    .select(
      'reservations.*',
      'guests.first_name as guest_first_name',
      'guests.last_name as guest_last_name',
      'guests.phone as guest_phone'
    );
}

/**
 * Gap closure (user-reported follow-up): Departures and In-House are both
 * filtered to `status: 'checked_in'` — a real physical room DOES exist for
 * every row on these two boards specifically (unlike Arrivals, still
 * pre-check-in, which stays on `selectReservationWithGuest` alone — there
 * is no room to show yet). LEFT JOIN, not inner: `reservation_rooms`'s own
 * `effective_to IS NULL` condition is a real predicate that could
 * legitimately match nothing for a row this query wasn't expecting (a
 * defensive choice, not because it should ever actually happen for a
 * checked_in reservation) — an inner join here would silently drop such a
 * row off the board entirely rather than showing it with no room number.
 *
 * Gap closure (user-reported): the folio balance too — specifically the
 * OPEN folio, the exact same row `checkOut`'s own precondition (`Number(
 * folio.balance) !== 0`) checks, so what this board shows is always the
 * number checkout will actually gate on, never a different one. LEFT JOIN
 * again — a checked_in reservation should always have one (opened at
 * check-in), but showing "—" for a row this query didn't expect to lack
 * one beats silently dropping it from the board.
 */
function selectReservationWithGuestAndRoom(query) {
  return selectReservationWithGuest(query)
    .joinScoped(
      'reservation_rooms',
      (join) => join.on('reservation_rooms.reservation_id', '=', 'reservations.id').onNull('reservation_rooms.effective_to'),
      { type: 'left' }
    )
    .joinScoped('rooms', (join) => join.on('rooms.id', '=', 'reservation_rooms.room_id'), { type: 'left' })
    .joinScoped(
      'folios',
      (join) => join.on('folios.reservation_id', '=', 'reservations.id').andOnVal('folios.status', '=', 'open'),
      { type: 'left' }
    )
    .select('rooms.room_number as room_number', 'folios.balance as folio_balance', 'folios.currency as folio_currency');
}

/**
 * Gap closure (user-reported follow-up): Arrivals has no ACTUAL room yet —
 * that stays true, per every earlier note in this file — but a reservation
 * may carry a `preferred_room_id` (a request, never a lock — see
 * `createReservation`'s own header), which front desk genuinely wants to
 * see before opening the check-in dialog. LEFT JOIN directly on
 * `reservations.preferred_room_id = rooms.id`, not through
 * `reservation_rooms` at all — there is no assignment row to join through
 * pre-check-in; a preference is a plain column on the reservation itself.
 * Selected under its own name (`preferred_room_number`), never
 * `room_number`, so the frontend cannot conflate "requested" with
 * "assigned" — the same distinction `FrontDeskTab`'s own check-in dialog
 * already draws when it pre-fills from this same column.
 */
function selectReservationWithGuestAndPreferredRoom(query) {
  return selectReservationWithGuest(query)
    .joinScoped('rooms', (join) => join.on('rooms.id', '=', 'reservations.preferred_room_id'), { type: 'left' })
    .select('rooms.room_number as preferred_room_number');
}

async function listArrivals({ context }) {
  const db = scopedDb().for(context);
  const businessDate = await propertyBusinessDate({ context });
  return selectReservationWithGuestAndPreferredRoom(
    db.table('reservations').where({ 'reservations.arrival_date': businessDate, 'reservations.status': 'confirmed' })
  ).orderBy('reservations.id');
}

async function listDepartures({ context }) {
  const db = scopedDb().for(context);
  const businessDate = await propertyBusinessDate({ context });
  return selectReservationWithGuestAndRoom(
    db.table('reservations').where({ 'reservations.departure_date': businessDate, 'reservations.status': 'checked_in' })
  ).orderBy('reservations.id');
}

async function listInHouse({ context }) {
  const db = scopedDb().for(context);
  return selectReservationWithGuestAndRoom(db.table('reservations').where({ 'reservations.status': 'checked_in' })).orderBy(
    'reservations.id'
  );
}

/**
 * Gap closure: "which actual room numbers are free right now," for a room
 * type — a genuinely different question from `checkAvailability`'s
 * sellable-count-vs-threshold, and answerable only as of the property's
 * CURRENT business date (see `room-availability.js`'s own header for why a
 * future date can't be). Serves both the walk-in path (§3.3's "surface
 * tonight's oversell position... before allowing the sale," shown alongside
 * it) and the check-in room picker.
 */
async function listFreeRoomsNow({ context, roomTypeId }) {
  const db = scopedDb().for(context);
  const stayDate = await propertyBusinessDate({ context });
  return sharedListFreeRoomsNow({ db, roomTypeId, stayDate });
}

/**
 * Gap closure (user-reported): the "Preferred room" picker on the booking
 * form used to source from every room of the type, unfiltered, so a room
 * already earmarked for one guest's stay could be offered — and picked
 * again — as the preference for a second, overlapping-dates guest. This
 * narrows that list, WITHOUT turning a preference into a lock: `checkIn`
 * still accepts any room, and this only changes what the picker OFFERS,
 * never what a caller may explicitly submit.
 *
 * Confirmed with the user: exclusion is DATE-OVERLAP aware, not a blanket
 * "hide until this other stay ends" rule — a room preferred for next week
 * must still be offered for a December booking, since there is no real
 * conflict. A room is excluded from `[arrivalDate, departureDate)` when:
 *
 * 1. It is the `preferred_room_id` of another reservation whose own stay
 *    overlaps this range and whose status is still "open" (tentative,
 *    confirmed, or checked_in) — a cancelled/no_show/checked_out
 *    reservation's preference no longer means anything.
 * 2. It is the room an ongoing `checked_in` reservation is ACTUALLY
 *    assigned to (via `reservation_rooms`, `effective_to IS NULL`) for an
 *    overlapping stay — covers the case where that guest never expressed a
 *    preference of their own but is demonstrably in the room.
 * 3. It is not yet marked clean by housekeeping AND the new booking's
 *    arrival is the property's own CURRENT business date — the "checked
 *    out and clean" half of the user's request: once a reservation is
 *    checked_out it drops out of (1)/(2) entirely (there is no longer an
 *    open assignment or an "open" status), so the only way a same-day
 *    turnover still excludes the room is this real-time housekeeping
 *    check, which naturally stops applying to a future-dated booking
 *    (housekeeping will have caught up by then).
 */
async function listEligiblePreferredRooms({ context, roomTypeId, arrivalDate, departureDate }) {
  const db = scopedDb().for(context);
  const oooRoomIds = await outOfOrderRoomIds({ db, stayDate: arrivalDate });

  let roomsQuery = db.table('rooms').where({ status: 'active', has_discrepancy: false, room_type_id: roomTypeId });
  if (oooRoomIds.length > 0) roomsQuery = roomsQuery.whereNotIn('id', oooRoomIds);
  const candidateRooms = await roomsQuery.select('id', 'room_number', 'floor', 'housekeeping_reported_status');

  const preferenceCommits = await db
    .table('reservations')
    .whereNotNull('preferred_room_id')
    .whereIn('status', ['tentative', 'confirmed', 'checked_in'])
    .select('preferred_room_id as room_id', 'arrival_date', 'departure_date');

  const assignmentCommits = await db
    .table('reservation_rooms')
    .joinScoped('reservations', (join) => join.on('reservations.id', '=', 'reservation_rooms.reservation_id'))
    .whereNull('reservation_rooms.effective_to')
    .select('reservation_rooms.room_id as room_id', 'reservations.arrival_date', 'reservations.departure_date');

  const overlapsRange = (commit) => arrivalDate < commit.departure_date && commit.arrival_date < departureDate;
  const committedRoomIds = new Set(
    [...preferenceCommits, ...assignmentCommits].filter(overlapsRange).map((commit) => String(commit.room_id))
  );

  const businessDate = await propertyBusinessDate({ context });
  const isArrivingNow = businessDate != null && arrivalDate === businessDate;

  return candidateRooms.filter((room) => {
    if (committedRoomIds.has(String(room.id))) return false;
    if (isArrivingNow && room.housekeeping_reported_status !== 'clean') return false;
    return true;
  });
}

/**
 * PLAN.md Phase 4 (POS core): "look up an in-house guest by room number or
 * name" (PRODUCT_REQUIREMENTS.md §3.4's charge-to-room settlement) — the
 * one search this codebase needed a 3-table join for, via the scoped
 * accessor's own `joinScoped` (`src/modules/tenancy/scoped-db.js`), the
 * same mechanism `users/service.js`'s `listUsers` and `reporting/service.js`
 * already use for their own single joins. Returns candidates only — the
 * caller (POS settlement) re-checks in-house status and the open folio
 * fresh at charge time rather than trusting a stale search result, per
 * that section's own "reject if ... the guest has checked out" rule.
 */
async function findInHouseForCharge({ context, query }) {
  const db = scopedDb().for(context);
  const pattern = `%${query}%`;
  return db
    .table('reservations')
    .joinScoped('reservation_rooms', (join) =>
      join.on('reservation_rooms.reservation_id', '=', 'reservations.id').onNull('reservation_rooms.effective_to')
    )
    .joinScoped('rooms', (join) => join.on('rooms.id', '=', 'reservation_rooms.room_id'))
    .joinScoped('guests', (join) => join.on('guests.id', '=', 'reservations.guest_id'))
    .where({ 'reservations.status': 'checked_in' })
    .where((group) =>
      group.where('rooms.room_number', 'like', pattern).orWhere('guests.first_name', 'like', pattern).orWhere('guests.last_name', 'like', pattern)
    )
    .select(
      'reservations.id as reservationId',
      'rooms.room_number as roomNumber',
      'guests.first_name as guestFirstName',
      'guests.last_name as guestLastName'
    )
    .orderBy('rooms.room_number')
    .limit(20);
}

module.exports = {
  generateUlid,
  expandStayDates,
  isValidTransition,
  computeEarlyLateFee,
  createGuest,
  getGuest,
  listGuests,
  activityCutoffDate,
  getActiveGuestIds,
  checkAvailability,
  reserveInventoryForDates,
  releaseInventoryForDates,
  configureOverbookingThreshold,
  createReservation,
  openBookingFolio,
  confirmReservation,
  promoteWaitlist,
  cancelReservation,
  markNoShow,
  checkIn,
  checkOut,
  roomMove,
  extendStay,
  getReservation,
  listReservations,
  listWaitlist,
  addNote,
  listNotes,
  listArrivals,
  listDepartures,
  listInHouse,
  listFreeRoomsNow,
  listEligiblePreferredRooms,
  findInHouseForCharge,
};
