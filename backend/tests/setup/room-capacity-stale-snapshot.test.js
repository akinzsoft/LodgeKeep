'use strict';

/**
 * The stale-snapshot oversell, reproduced under REAL concurrent connections.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────
 * MySQL's default isolation is REPEATABLE READ: a transaction's plain
 * (non-locking) reads all see the snapshot established by its FIRST read.
 * Every booking starts with a plain read (the idempotency-key lookup), then
 * waits for the `room_type_inventory` row lock, then decides whether the
 * night still has capacity by COUNTING the type's rooms — with another plain
 * read. If a writer that lowers capacity (a room moved to another type, a
 * room archived or deleted, an out-of-order period) commits while the
 * booking is queued on that lock, the booking still counts the OLD rooms: it
 * takes the lock, reads a snapshot from before the writer committed, and
 * accepts a booking the type no longer has room for. The night is oversold
 * with no error anywhere.
 *
 * The room-management writers had the mirror-image flaw: two concurrent
 * changes to DIFFERENT rooms of the same type each computed "capacity after"
 * from a snapshot that predated the other, so each passed and together they
 * oversold the night.
 *
 * ── HOW THIS FILE FORCES THE INTERLEAVING (no mocks, no sequential fakes) ─
 * A third connection holds `FOR UPDATE` on the type's inventory rows while
 * each request is started in turn. Every request runs its own plain reads
 * (taking its snapshot), then queues on the row lock. Each test asserts that
 * NEITHER request had answered before the blocker released — proof that both
 * were genuinely waiting, i.e. that the stale-snapshot window really was
 * open — and only then commits the blocker. InnoDB grants queued lock
 * requests in arrival order, so the first request started is the first to
 * commit and the second is left holding a snapshot older than that commit.
 * (The test user has no PROCESS privilege, so lock waits cannot be read from
 * `INNODB_TRX`; "still unanswered after a generous pause" is the observable.)
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

const QUEUE_PAUSE_MS = 700;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('room capacity vs concurrent writers — the stale-snapshot oversell', () => {
  let req;
  let tenantId;
  let propertyId;
  let guestId;
  let rateCodeId;
  let token;
  let seq = 0;

  const post = (path, body = {}) =>
    req.post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `snap-${(seq += 1)}-${Date.now()}`).send(body);

  /** Starts a request NOW (supertest is lazy) and lets the test see whether it has answered. */
  function start(test) {
    const state = { done: false };
    state.promise = test.then((response) => {
      state.done = true;
      return response;
    });
    return state;
  }

  async function createType(code) {
    const [id] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: `${code}-${(seq += 1)}`,
      name: code,
      default_occupancy: 2,
      base_rate: '100.00',
    });
    return id;
  }

  async function createRoom(typeId, number) {
    const [id] = await db()('rooms').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      room_type_id: typeId,
      room_number: `${number}-${(seq += 1)}`,
      housekeeping_reported_status: 'clean',
    });
    return id;
  }

  const bookBody = (typeId, date, extra = {}) => {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      guest_id: String(guestId),
      room_type_id: String(typeId),
      rate_code_id: String(rateCodeId),
      arrival_date: date,
      departure_date: next.toISOString().slice(0, 10),
      ...extra,
    };
  };

  async function book(typeId, date) {
    const res = await post('/reservations', bookBody(typeId, date));
    expect(res.status).toBe(201);
    return res.body.data;
  }

  /** A third connection that holds the type's inventory rows, so every request queues behind it. */
  async function holdInventory(typeId) {
    const blocker = await db().transaction();
    await blocker('room_type_inventory').where({ tenant_id: tenantId, room_type_id: typeId }).forUpdate();
    return blocker;
  }

  /** Nights sold must never exceed the rooms that can actually be sold that night. */
  async function expectNotOversold(typeId, date) {
    const inventory = await db()('room_type_inventory').where({ room_type_id: typeId, stay_date: date }).first();
    const rooms = await db()('rooms').where({ room_type_id: typeId, status: 'active', has_discrepancy: false });
    const outOfOrder = await db()('out_of_order_periods')
      .whereIn('room_id', rooms.map((room) => room.id))
      .where('start_date', '<=', date)
      .where('end_date', '>=', date);
    const blockedIds = new Set(outOfOrder.map((period) => String(period.room_id)));
    const capacity = rooms.filter((room) => !blockedIds.has(String(room.id))).length;
    expect({ rooms_sold: inventory.rooms_sold, capacity_ok: inventory.rooms_sold <= capacity, capacity }).toMatchObject({ capacity_ok: true });
  }

  /**
   * Either side may win the lock race — what must hold is that exactly one of
   * "the room leaves the type" and "the extra booking lands" happens, never
   * both (which is the oversell) and never neither. Asserting a fixed winner
   * would make these tests depend on InnoDB's lock-grant ordering, which is
   * arrival-order in practice but not a documented guarantee.
   */
  function expectExactlyOneLands({ change, booking }) {
    const changeLanded = change.status === 200;
    const bookingLanded = booking.status === 201;
    expect({ changeLanded, bookingLanded, changeStatus: change.status, bookingStatus: booking.status }).toEqual(
      changeLanded
        ? { changeLanded: true, bookingLanded: false, changeStatus: 200, bookingStatus: 422 }
        : { changeLanded: false, bookingLanded: true, changeStatus: 409, bookingStatus: 201 }
    );
  }

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Snapshot Tenant', slug: `snap-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `snap-property-${suffix}`,
      name: 'Snapshot Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'admin', name: 'admin', is_system: true });
    const [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `snap-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Snap',
      last_name: 'Admin',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'admin' });
    const perms = await db()('permissions')
      .whereIn('permission_key', ['setup.view', 'setup.manage', 'reservations.view', 'reservations.manage', 'front_desk.view', 'front_desk.manage', 'housekeeping.view', 'housekeeping.manage'])
      .select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'Snap', last_name: 'Guest' });
    [rateCodeId] = await db()('rate_codes').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'SNAPRATE',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    const t = { tenant_id: tenantId };
    await db()('audit_log').where(t).delete();
    await db()('outbox_events').where(t).delete();
    await db()('idempotency_keys').where(t).delete();
    await db()('in_app_notifications').where(t).delete();
    await db()('reservation_rooms').where(t).delete();
    await db()('folio_line_items').where(t).delete();
    await db()('folios').where(t).delete();
    await db()('reservation_daily_rates').where(t).delete();
    await db()('room_type_inventory').where(t).delete();
    await db()('reservations').where(t).delete();
    await db()('out_of_order_periods').where(t).delete();
    await db()('rate_codes').where(t).delete();
    await db()('rooms').where(t).delete();
    await db()('room_types').where(t).delete();
    await db()('guests').where(t).delete();
    await db()('user_property_access').where(t).delete();
    await db()('role_permissions').where(t).delete();
    await db()('users').where(t).delete();
    await db()('roles').where(t).delete();
    await db()('properties').where(t).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  /**
   * Runs `first` then `second` as two requests that both queue behind a held
   * inventory lock, with `between` (optional) run while only `first` is queued.
   * Returns both responses once the lock is released.
   */
  async function raceBehindLock(typeId, first, second) {
    const blocker = await holdInventory(typeId);
    let a;
    let b;
    try {
      a = start(first());
      await sleep(QUEUE_PAUSE_MS);
      b = start(second());
      await sleep(QUEUE_PAUSE_MS);
      // Both must genuinely be waiting on the lock — otherwise the stale-snapshot window was never open and this test proves nothing.
      expect({ firstAnswered: a.done, secondAnswered: b.done }).toEqual({ firstAnswered: false, secondAnswered: false });
    } finally {
      await blocker.commit();
    }
    return Promise.all([a.promise, b.promise]);
  }

  it('a booking queued behind a room MOVE must see the move — it cannot oversell the type', async () => {
    const fromType = await createType('SNAP-MOVE');
    const toType = await createType('SNAP-MOVE-TO');
    const roomA = await createRoom(fromType, 'M1');
    await createRoom(fromType, 'M2');
    await book(fromType, '2034-03-10'); // one of the two rooms is sold that night

    // The move is first in the lock queue, so it commits first; the booking's snapshot predates that commit.
    const [move, booking] = await raceBehindLock(
      fromType,
      () => post(`/rooms/${roomA}/change-type`, { room_type_id: String(toType) }),
      () => post('/reservations', bookBody(fromType, '2034-03-10'))
    );

    expectExactlyOneLands({ change: move, booking });
    await expectNotOversold(fromType, '2034-03-10');
  });

  it('a booking queued behind a room ARCHIVE must see the archive', async () => {
    const type = await createType('SNAP-ARCH');
    const roomA = await createRoom(type, 'A1');
    await createRoom(type, 'A2');
    await book(type, '2034-04-10');

    const [archive, booking] = await raceBehindLock(
      type,
      () => post(`/rooms/${roomA}/archive`, { reason: 'race' }),
      () => post('/reservations', bookBody(type, '2034-04-10'))
    );

    expectExactlyOneLands({ change: archive, booking });
    await expectNotOversold(type, '2034-04-10');
  });

  it('a booking queued while a room is taken OUT OF ORDER must see the out-of-order period', async () => {
    const type = await createType('SNAP-OOO');
    const only = await createRoom(type, 'O1');
    // An inventory row must exist for the blocker to hold; nothing is sold yet.
    await db()('room_type_inventory').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: type, stay_date: '2034-05-10', rooms_sold: 0 });

    const blocker = await holdInventory(type);
    let booking;
    try {
      booking = start(post('/reservations', bookBody(type, '2034-05-10')));
      await sleep(QUEUE_PAUSE_MS);
      expect(booking.done).toBe(false); // queued, snapshot already taken

      // Out-of-order creation takes no inventory lock, so it commits while the booking waits.
      const ooo = await post('/housekeeping/out-of-order', { room_id: String(only), type: 'ooo', reason: 'flood', start_date: '2034-05-01', end_date: '2034-05-31' });
      expect(ooo.status).toBe(201);
    } finally {
      await blocker.commit();
    }

    const response = await booking.promise;
    expect(response.status).toBe(422);
    await expectNotOversold(type, '2034-05-10');
  });

  it('two concurrent moves of DIFFERENT rooms of one type: each alone fits, together they do not — exactly one may land', async () => {
    const fromType = await createType('SNAP-TWO');
    const toType = await createType('SNAP-TWO-TO');
    const r1 = await createRoom(fromType, 'T1');
    const r2 = await createRoom(fromType, 'T2');
    await createRoom(fromType, 'T3');
    await book(fromType, '2034-06-10');
    await book(fromType, '2034-06-10'); // two of three rooms sold: moving one leaves 2 (fits), moving both leaves 1 (does not)

    const [first, second] = await raceBehindLock(
      fromType,
      () => post(`/rooms/${r1}/change-type`, { room_type_id: String(toType) }),
      () => post(`/rooms/${r2}/change-type`, { room_type_id: String(toType) })
    );

    const landed = [first, second].filter((response) => response.status === 200).length;
    const refused = [first, second].filter((response) => response.status === 409 && response.body.error.details.blocked[0].reasons.some((r) => r.code === 'WOULD_OVERBOOK')).length;
    expect({ landed, refused }).toEqual({ landed: 1, refused: 1 });
    await expectNotOversold(fromType, '2034-06-10');
  });

  it('a room ARCHIVE racing a room MOVE out of the same type cannot together oversell it', async () => {
    const fromType = await createType('SNAP-MIX');
    const toType = await createType('SNAP-MIX-TO');
    const r1 = await createRoom(fromType, 'X1');
    const r2 = await createRoom(fromType, 'X2');
    await createRoom(fromType, 'X3');
    await book(fromType, '2034-07-10');
    await book(fromType, '2034-07-10');

    const [archive, move] = await raceBehindLock(
      fromType,
      () => post(`/rooms/${r1}/archive`, { reason: 'race' }),
      () => post(`/rooms/${r2}/change-type`, { room_type_id: String(toType) })
    );

    expect([archive.status, move.status].sort()).toEqual([200, 409]);
    await expectNotOversold(fromType, '2034-07-10');
  });

  /**
   * A reservation must never end up preferring a room that is archived or of a
   * different type than the reservation's own. Room management clears the
   * preference on reservations that EXIST when it runs; a booking queued
   * behind it does not exist yet, so its preference has to be re-validated
   * under the room lock after the inventory lock.
   */
  async function expectNoStalePreferences(typeId) {
    const stale = await db()('reservations')
      .join('rooms', 'rooms.id', 'reservations.preferred_room_id')
      .where('reservations.room_type_id', typeId) // this test's own data only — an earlier test's leftovers must not fail a later one
      .whereIn('reservations.status', ['tentative', 'confirmed', 'checked_in'])
      .where(function retiredOrWrongType() {
        this.whereNot('rooms.status', 'active').orWhereRaw('rooms.room_type_id <> reservations.room_type_id');
      })
      .select('reservations.id', 'reservations.preferred_room_id', 'rooms.status');
    expect(stale).toEqual([]);
  }

  it('a booking queued behind an ARCHIVE cannot save the archived room as its preferred room', async () => {
    const type = await createType('SNAP-PREF-ARCH');
    const preferred = await createRoom(type, 'P1');
    await createRoom(type, 'P2');
    await db()('room_type_inventory').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: type, stay_date: '2034-08-10', rooms_sold: 0 });

    const [archive, booking] = await raceBehindLock(
      type,
      () => post(`/rooms/${preferred}/archive`, { reason: 'race' }),
      () => post('/reservations', bookBody(type, '2034-08-10', { preferred_room_id: String(preferred) }))
    );

    expect(archive.status).toBe(200);
    expect({ status: booking.status, code: booking.body?.error?.code }).toEqual({ status: 400, code: 'VALIDATION_PREFERRED_ROOM_NOT_ACTIVE' });
    await expectNoStalePreferences(type);
  });

  it('a booking queued behind a room MOVE cannot save the moved room (now another type) as its preferred room', async () => {
    const fromType = await createType('SNAP-PREF-MOVE');
    const toType = await createType('SNAP-PREF-MOVE-TO');
    const preferred = await createRoom(fromType, 'Q1');
    await createRoom(fromType, 'Q2');
    await db()('room_type_inventory').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: fromType, stay_date: '2034-09-10', rooms_sold: 0 });

    const [move, booking] = await raceBehindLock(
      fromType,
      () => post(`/rooms/${preferred}/change-type`, { room_type_id: String(toType) }),
      () => post('/reservations', bookBody(fromType, '2034-09-10', { preferred_room_id: String(preferred) }))
    );

    expect(move.status).toBe(200);
    expect({ status: booking.status, code: booking.body?.error?.code }).toEqual({ status: 400, code: 'VALIDATION_PREFERRED_ROOM_TYPE_MISMATCH' });
    await expectNoStalePreferences(fromType);
  });

  it('the other order is fine too: a booking that lands first has its preference cleared by the room change', async () => {
    const fromType = await createType('SNAP-PREF-FIRST');
    const toType = await createType('SNAP-PREF-FIRST-TO');
    const preferred = await createRoom(fromType, 'R1');
    await createRoom(fromType, 'R2');
    await db()('room_type_inventory').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: fromType, stay_date: '2034-10-10', rooms_sold: 0 });

    // Booking first in the lock queue this time, the room move second.
    const [booking, move] = await raceBehindLock(
      fromType,
      () => post('/reservations', bookBody(fromType, '2034-10-10', { preferred_room_id: String(preferred) })),
      () => post(`/rooms/${preferred}/change-type`, { room_type_id: String(toType) })
    );

    expect(booking.status).toBe(201);
    expect(move.status).toBe(200);
    expect(move.body.data.cleared_preferences.map((row) => row.reservation_id)).toEqual([booking.body.data.id]);
    await expectNoStalePreferences(fromType);
  });
});
