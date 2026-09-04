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

const crypto = require('crypto');
const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { resolveRate } = require('../setup/service');
const {
  OverbookingThresholdExceededError,
  RoomUnavailableError,
  RoomNotCleanError,
  InvalidReservationTransitionError,
  ArrivalAfterDepartureError,
  FolioBalanceOwingError,
} = require('./errors');

// ---------------------------------------------------------------------
// Pure functions — exported for direct unit testing, no database.
// ---------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID (ARCHITECTURE.md §10: "UUID/ULID ... safe to expose without
 * revealing sequence/volume information") — 48-bit millisecond timestamp
 * (10 base32 chars) + 80 bits of randomness (16 base32 chars), Crockford's
 * alphabet. No package dependency added for this: the algorithm is a dozen
 * lines, and `reservations.confirmation_number`/`folios.folio_number` are
 * both sized `varchar(26)` for exactly this format.
 */
function generateUlid(now = Date.now(), randomBytes = crypto.randomBytes) {
  let time = BigInt(now);
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = ULID_ALPHABET[Number(time % 32n)] + timePart;
    time /= 32n;
  }

  let random = 0n;
  for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) {
    randomPart = ULID_ALPHABET[Number(random % 32n)] + randomPart;
    random /= 32n;
  }

  return timePart + randomPart;
}

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
 * Live physical count — see `room_type_inventory` migration's own header
 * for why this is computed here rather than cached: `rooms.status` is the
 * one live source of truth, no separate column to keep in sync.
 */
async function livePhysicalCount({ db, roomTypeId }) {
  return db.table('rooms').where({ room_type_id: roomTypeId, status: 'active' }).count();
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

    const physicalCount = await livePhysicalCount({ db: trx, roomTypeId });
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

/** Read-only availability search (PRODUCT_REQUIREMENTS.md §3.2) — no lock, a point-in-time answer that createReservation re-verifies for real under lock. */
async function checkAvailability({ context, roomTypeId, arrivalDate, departureDate }) {
  const db = scopedDb().for(context);
  const stayDates = expandStayDates(arrivalDate, departureDate);
  const physicalCount = await livePhysicalCount({ db, roomTypeId });

  const rows = await db
    .table('room_type_inventory')
    .where({ room_type_id: roomTypeId })
    .whereIn('stay_date', stayDates);
  const rowByDate = new Map(rows.map((r) => [String(r.stay_date), r]));

  const nights = stayDates.map((stayDate) => {
    const row = rowByDate.get(stayDate);
    const thresholdPct = row ? Number(row.overbooking_threshold_pct) : 100;
    const roomsSold = row ? row.rooms_sold : 0;
    const threshold = Math.floor((physicalCount * thresholdPct) / 100);
    return { stayDate, physicalCount, roomsSold, threshold, sellable: Math.max(0, threshold - roomsSold) };
  });

  return { roomTypeId, physicalCount, nights, minSellable: Math.min(...nights.map((n) => n.sellable)) };
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
}) {
  if (!(departureDate > arrivalDate)) {
    throw new ArrivalAfterDepartureError();
  }
  const stayDates = expandStayDates(arrivalDate, departureDate);

  const rateCode = await trx.table('rate_codes').where({ id: rateCodeId }).first();
  if (!rateCode) {
    throw new ValidationError('RATE_CODE_NOT_FOUND', 'The specified rate code does not exist at this property.');
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

  return trx.table('reservations').where({ id }).first();
}

/** `tentative` -> `confirmed`. No inventory change: a tentative hold already counts against sellable inventory (§11). */
async function confirmReservation({ trx, id }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (!isValidTransition(reservation.status, 'confirmed')) {
    throw new InvalidReservationTransitionError(reservation.status, 'confirmed');
  }
  await trx.table('reservations').where({ id }).update({ status: 'confirmed' });
  return trx.table('reservations').where({ id }).first();
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
  return trx.table('reservations').where({ id }).first();
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
  return trx.table('reservations').where({ id }).first();
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

  const occupied = await trx.table('reservation_rooms').where({ room_id: roomId, effective_to: null }).first();
  if (occupied) {
    throw new RoomUnavailableError(roomId);
  }

  const now = new Date();
  await trx.table('reservation_rooms').insert({ reservation_id: id, room_id: roomId, effective_from: now, effective_to: null });

  const dailyRate = await trx.table('reservation_daily_rates').where({ reservation_id: id }).first();
  await trx.table('folios').insert({
    reservation_id: id,
    folio_number: generateUlid(),
    status: 'open',
    balance: '0.00',
    currency: dailyRate.currency,
  });

  await trx.table('reservations').where({ id }).update({ status: 'checked_in', checked_in_at: now });
  return trx.table('reservations').where({ id }).first();
}

/**
 * TESTING.md FD-4/FD-5/FD-6. The folio balance must be zero going INTO
 * checkout (§11's literal precondition) — always true in this pass since
 * nothing can post a charge yet, except a test fixture that sets one
 * directly to exercise FD-4's guard. Any early/late fee is computed and
 * recorded on the folio's `balance` AS PART OF this same checkout, not
 * blocked on: this pass has no payment-capture mechanism to collect it
 * (Cashiering), so the fee is recorded for visibility, and checkout still
 * completes — flagged rather than silently pretended away.
 */
async function checkOut({ trx, id, scheduledCheckoutTime, actualCheckoutTime, earlyCutoffTime, earlyDepartureFee, lateCheckoutFee }) {
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

  let fee = null;
  if (scheduledCheckoutTime && actualCheckoutTime) {
    fee = computeEarlyLateFee({ scheduledCheckoutTime, actualCheckoutTime, earlyCutoffTime, earlyDepartureFee, lateCheckoutFee });
  }
  const finalBalance = fee ? Number(fee.amount).toFixed(2) : '0.00';

  const now = new Date();
  await trx.table('folios').where({ id: folio.id }).update({ balance: finalBalance, status: 'closed', closed_at: now });
  await trx.table('reservation_rooms').where({ reservation_id: id, effective_to: null }).update({ effective_to: now });
  await trx.table('reservations').where({ id }).update({ status: 'checked_out', checked_out_at: now });

  return { reservation: await trx.table('reservations').where({ id }).first(), fee };
}

/** TESTING.md FD-3. Closes the current assignment and opens a new one — `reservation_rooms` keeps both rows, never overwritten. */
async function roomMove({ trx, id, newRoomId, reason }) {
  const reservation = await trx.table('reservations').where({ id }).first();
  if (!reservation) return null;
  if (reservation.status !== 'checked_in') {
    throw new ValidationError('NOT_CHECKED_IN', 'A room move requires the reservation to be checked in.');
  }

  const occupied = await trx.table('reservation_rooms').where({ room_id: newRoomId, effective_to: null }).first();
  if (occupied) {
    throw new RoomUnavailableError(newRoomId);
  }

  const now = new Date();
  await trx.table('reservation_rooms').where({ reservation_id: id, effective_to: null }).update({ effective_to: now });
  await trx.table('reservation_rooms').insert({ reservation_id: id, room_id: newRoomId, effective_from: now, effective_to: null, reason: reason ?? null });
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
};
