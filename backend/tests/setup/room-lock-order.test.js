'use strict';

/**
 * Lock ORDER and archived-room safety under real concurrent connections — the
 * three things that a single-connection test cannot show:
 *
 *   #2  A data import row must not put an in-house guest into a room that was
 *       archived after the import run read its room list.
 *   #3  Room management must not cycle with a front-desk room move: it used to
 *       lock the batch rooms and then reach back for a lower-id room of the
 *       same type, while a move locks its own two rooms in ascending order.
 *   #4  A data import row must not cycle with a booking of the same type: the
 *       import locked a room and then wanted inventory, while a booking (since
 *       it started share-locking rooms) holds inventory and wants rooms.
 *
 * Same harness as `room-capacity-stale-snapshot.test.js`: a third connection
 * holds a lock so every request queues behind it in a known order, each test
 * asserts that the requests really were still waiting, and only then lets go.
 * For #3 and #4 the failure being ruled out is a DEADLOCK, which InnoDB
 * resolves by aborting one side — so "no deadlock" is asserted directly
 * (`retryStats` for room management, status/row outcome for the others), not
 * inferred from the final state, which a retry would hide.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const roomManagement = require('../../src/modules/setup/room-management');
const { runImportCommitJob } = require('../../src/jobs/data-import');

const QUEUE_PAUSE_MS = 700;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('room lock order and archived-room safety under real concurrent connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let userId;
  let guestId;
  let guestEmail;
  let rateCodeId;
  let token;
  let seq = 0;
  const tempFiles = [];

  const post = (route, body = {}) =>
    req.post(`/api/v1${route}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `lo-${(seq += 1)}-${Date.now()}`).send(body);

  function start(work) {
    const state = { done: false };
    state.promise = Promise.resolve(work).then(
      (value) => {
        state.done = true;
        return value;
      },
      (error) => {
        state.done = true;
        throw error;
      }
    );
    // A rejected promise nobody has awaited yet must not fail the run as unhandled.
    state.promise.catch(() => {});
    return state;
  }

  async function createType(code) {
    const [id] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: `${code}${(seq += 1)}`,
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
      room_number: `${number}${(seq += 1)}`,
      housekeeping_reported_status: 'clean',
    });
    return id;
  }

  const bookBody = (typeId, date) => {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      guest_id: String(guestId),
      room_type_id: String(typeId),
      rate_code_id: String(rateCodeId),
      arrival_date: date,
      departure_date: next.toISOString().slice(0, 10),
    };
  };

  async function ensureInventoryRows(typeId, dates) {
    for (const stayDate of dates) {
      await db()('room_type_inventory').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: typeId, stay_date: stayDate, rooms_sold: 0 });
    }
  }

  /** A third connection holding one room row `FOR UPDATE`. */
  async function holdRoom(roomId) {
    const blocker = await db().transaction();
    await blocker('rooms').where({ id: roomId }).forUpdate();
    return blocker;
  }

  /** A committing import run with one in-house reservation row, ready for `runImportCommitJob`. */
  async function createInHouseImportRun({ typeCode, roomNumber, arrival, departure }) {
    const file = path.join(os.tmpdir(), `lodgekeep-import-${tenantId}-${(seq += 1)}.csv`);
    const header = 'guest_email,guest_phone,room_type_code,rate_code,arrival_date,departure_date,adults,children,status,room_number';
    fs.writeFileSync(file, `${header}\n${guestEmail},,${typeCode},RMLO,${arrival},${departure},1,0,checked_in,${roomNumber}\n`);
    tempFiles.push(file);
    const [importRunId] = await db()('import_runs').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      entity_type: 'reservations',
      status: 'committing',
      original_filename: 'in-house.csv',
      file_path: file,
      run_by_user_id: userId,
    });
    return importRunId;
  }

  const roomRow = (id) => db()('rooms').where({ id }).first();

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Lock Order Tenant', slug: `lockorder-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `lockorder-property-${suffix}`,
      name: 'Lock Order Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'admin', name: 'admin', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `lockorder-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Lock',
      last_name: 'Admin',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'admin' });
    const perms = await db()('permissions')
      .whereIn('permission_key', ['setup.view', 'setup.manage', 'reservations.view', 'reservations.manage', 'front_desk.view', 'front_desk.manage'])
      .select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    guestEmail = `lockorder-guest-${suffix}@example.com`;
    [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'Lock', last_name: 'Guest', email: guestEmail });
    [rateCodeId] = await db()('rate_codes').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'RMLO',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    const t = { tenant_id: tenantId };
    await db()('imported_record_map').where(t).delete();
    await db()('import_row_errors').where(t).delete();
    await db()('import_runs').where(t).delete();
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
    for (const file of tempFiles) fs.rmSync(file, { force: true });
    dbModule.__resetForTesting();
  });

  it('#2 an import row cannot put an in-house guest into a room archived after the run read its room list', async () => {
    const typeId = await createType('LO-ARCH');
    const target = await createRoom(typeId, 'T');
    await createRoom(typeId, 'SPARE');
    const targetNumber = (await roomRow(target)).room_number;
    const dates = ['2035-03-10', '2035-03-11'];
    await ensureInventoryRows(typeId, dates);
    const typeCode = (await db()('room_types').where({ id: typeId }).first()).code;
    const importRunId = await createInHouseImportRun({ typeCode, roomNumber: targetNumber, arrival: dates[0], departure: '2035-03-12' });

    // The archive is first in line for the room; the import (which has already
    // read its room list, showing the room active) queues behind it.
    const blocker = await holdRoom(target);
    let archive;
    let importJob;
    try {
      archive = start(post(`/rooms/${target}/archive`, { reason: 'retired before the import got to it' }));
      await sleep(QUEUE_PAUSE_MS);
      importJob = start(runImportCommitJob({ tenantId, importRunId }));
      await sleep(QUEUE_PAUSE_MS);
      expect({ archiveAnswered: archive.done, importFinished: importJob.done }).toEqual({ archiveAnswered: false, importFinished: false });
    } finally {
      await blocker.commit();
    }
    const archived = await archive.promise;
    await importJob.promise;

    expect(archived.status).toBe(200);
    const run = await db()('import_runs').where({ id: importRunId }).first();
    const errors = await db()('import_row_errors').where({ import_run_id: importRunId });
    expect({ status: run.status, created: run.rows_created, skipped: run.rows_skipped }).toEqual({ status: 'completed', created: 0, skipped: 1 });
    expect(errors.map((row) => row.message).join(' ')).toMatch(/archived/);

    // The room is retired AND empty: no guest was put in it.
    const room = await roomRow(target);
    expect({ status: room.status, frontDesk: room.front_desk_status }).toEqual({ status: 'archived', frontDesk: 'vacant' });
    expect(await db()('reservation_rooms').where({ room_id: target })).toEqual([]);
    // The skipped row's inventory hold rolled back with it.
    const sold = await db()('room_type_inventory').where({ room_type_id: typeId }).sum({ n: 'rooms_sold' }).first();
    expect(Number(sold.n)).toBe(0);
  });

  it('#4 an import row and a booking of the same type do not deadlock — inventory is locked before the room', async () => {
    const typeId = await createType('LO-IMP');
    const inHouse = await createRoom(typeId, 'I');
    await createRoom(typeId, 'J');
    await createRoom(typeId, 'K');
    const inHouseNumber = (await roomRow(inHouse)).room_number;
    const dates = ['2035-04-10', '2035-04-11'];
    await ensureInventoryRows(typeId, dates);
    const typeCode = (await db()('room_types').where({ id: typeId }).first()).code;
    const importRunId = await createInHouseImportRun({ typeCode, roomNumber: inHouseNumber, arrival: dates[0], departure: '2035-04-12' });

    // The import reaches its room first (held by the blocker). Old order: it
    // sits there holding NOTHING while a booking takes inventory and then
    // waits on the same room — and when the blocker lets go the import gets
    // the room and wants the inventory the booking holds: a cycle.
    const blocker = await holdRoom(inHouse);
    let importJob;
    let booking;
    try {
      importJob = start(runImportCommitJob({ tenantId, importRunId }));
      await sleep(QUEUE_PAUSE_MS);
      booking = start(post('/reservations', bookBody(typeId, dates[0])));
      await sleep(QUEUE_PAUSE_MS);
      expect({ importFinished: importJob.done, bookingAnswered: booking.done }).toEqual({ importFinished: false, bookingAnswered: false });
    } finally {
      await blocker.commit();
    }
    const [, bookingResponse] = await Promise.all([importJob.promise, booking.promise]);

    // Neither side was chosen as a deadlock victim.
    const run = await db()('import_runs').where({ id: importRunId }).first();
    const errors = await db()('import_row_errors').where({ import_run_id: importRunId });
    expect({ errors: errors.map((row) => row.message), status: run.status, created: run.rows_created, skipped: run.rows_skipped }).toEqual({
      errors: [],
      status: 'completed',
      created: 1,
      skipped: 0,
    });
    expect(bookingResponse.status).toBe(201);
    expect((await roomRow(inHouse)).front_desk_status).toBe('occupied');
  });

  it('#3 room management and a front-desk room move do not deadlock — every room lock is taken in one ascending pass', async () => {
    const fromType = await createType('LO-MOVE');
    const toType = await createType('LO-MOVE-TO');
    // Creation order = id order: r3 < r5 < r7 < r9, so the batch rooms (3 and 7)
    // straddle a same-type room (5) that a front-desk move is standing in.
    const r3 = await createRoom(fromType, 'M3');
    const r5 = await createRoom(fromType, 'M5');
    const r7 = await createRoom(fromType, 'M7');
    await createRoom(fromType, 'M9');
    const booked = await post('/reservations', bookBody(fromType, '2035-05-10'));
    expect(booked.status).toBe(201);
    const checkedIn = await post(`/reservations/${booked.body.data.id}/check-in`, { room_id: String(r5) });
    expect(checkedIn.status).toBe(200);

    const before = { ...roomManagement.retryStats };
    // The change reaches room 7 first (held by the blocker); the move then
    // stands on room 5 and also wants 7. Old code: the change holds 3 and 7,
    // then reaches back for 5, which the move holds while it waits for 7.
    const blocker = await holdRoom(r7);
    let change;
    let move;
    try {
      change = start(post('/rooms/change-type', { room_ids: [String(r3), String(r7)], room_type_id: String(toType) }));
      await sleep(QUEUE_PAUSE_MS);
      move = start(post(`/reservations/${booked.body.data.id}/room-move`, { new_room_id: String(r7), reason: 'guest asked' }));
      await sleep(QUEUE_PAUSE_MS);
      expect({ changeAnswered: change.done, moveAnswered: move.done }).toEqual({ changeAnswered: false, moveAnswered: false });
    } finally {
      await blocker.commit();
    }
    const [changeResponse, moveResponse] = await Promise.all([change.promise, move.promise]);

    // No 5xx from the front desk, and no retry hiding a deadlock in room management.
    expect({ change: changeResponse.status, move: moveResponse.status }).toEqual({ change: 200, move: 200 });
    expect(roomManagement.retryStats).toEqual(before);
  });
});
