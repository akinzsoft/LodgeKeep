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
const { livePhysicalCount: sharedLivePhysicalCount } = require('../../shared/room-availability');
const { generateUlid } = require('../../shared/ulid');
const { resolveRate } = require('../setup/service');
const { postAdjustment: postFolioAdjustment, ensurePrimaryFolio } = require('../cashiering/service');
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

async function listGuests({ context }) {
  const db = scopedDb().for(context);
  return db.table('guests').where({ status: 'active' }).orderBy('last_name');
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

async function listArrivals({ context }) {
  const db = scopedDb().for(context);
  const businessDate = await propertyBusinessDate({ context });
  return db.table('reservations').where({ arrival_date: businessDate, status: 'confirmed' }).orderBy('id');
}

async function listDepartures({ context }) {
  const db = scopedDb().for(context);
  const businessDate = await propertyBusinessDate({ context });
  return db.table('reservations').where({ departure_date: businessDate, status: 'checked_in' }).orderBy('id');
}

async function listInHouse({ context }) {
  const db = scopedDb().for(context);
  return db.table('reservations').where({ status: 'checked_in' }).orderBy('id');
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
  checkAvailability,
  reserveInventoryForDates,
  releaseInventoryForDates,
  configureOverbookingThreshold,
  createReservation,
  confirmReservation,
  promoteWaitlist,
  cancelReservation,
  markNoShow,
  checkIn,
  checkOut,
  roomMove,
  getReservation,
  listReservations,
  listWaitlist,
  addNote,
  listNotes,
  listArrivals,
  listDepartures,
  listInHouse,
  findInHouseForCharge,
};
