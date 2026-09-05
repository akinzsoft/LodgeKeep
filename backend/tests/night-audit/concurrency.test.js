'use strict';

/**
 * NA-2 (two workers trigger night audit for the same property at once —
 * exactly one succeeds) and NA-3 (killed mid-run, re-triggered, no
 * duplicate charges) — ARCHITECTURE.md §5's night-audit race and §6.3's
 * recovery model.
 *
 * ── WHY THIS FILE DOES NOT USE `useTestApp()` ───────────────────────────
 *
 * Same reasoning as `tests/reservations/concurrency.test.js` for RES-5:
 * two "concurrent" requests against the shared-transaction harness are
 * really two savepoints on the SAME MySQL session, which cannot block
 * itself — genuinely proving NA-2 needs two real, separate connections.
 * NA-3's stale-recovery path also needs a row that's genuinely COMMITTED
 * (not rolled back at file end) to simulate "a worker died mid-run" —
 * `dbModule.__setConnectionForTesting(db())` binds the app to the real
 * pooled connection, and this file seeds/cleans up real committed rows.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Night Audit concurrency and crash recovery (ARCHITECTURE.md §5/§6.3)', () => {
  let req;
  let tenantId;
  let propertyId;
  let userId;
  let roomTypeId;
  let roomId;
  let rateCodeId;
  let guestId;
  let folioId;
  let token;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    [tenantId] = await db()('tenants').insert({ name: 'NA Concurrency Tenant', slug: `na-concurrency-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `na-concurrency-property-${suffix}`,
      name: 'NA Concurrency Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2028-01-01',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `na-concurrency-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'NA',
      last_name: 'User',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });

    const perms = await db()('permissions').whereIn('permission_key', ['night_audit.view', 'night_audit.run']).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [roomTypeId] = await db()('room_types').insert({ tenant_id: tenantId, property_id: propertyId, code: 'NARACE', name: 'NA Race', default_occupancy: 2, base_rate: '120.00' });
    [roomId] = await db()('rooms').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: roomTypeId, room_number: '1', status: 'active', front_desk_status: 'occupied' });
    [rateCodeId] = await db()('rate_codes').insert({ tenant_id: tenantId, property_id: propertyId, code: 'NARACERATE', base_rate: '120.00', currency: 'NGN', valid_from: '2026-01-01' });
    [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'NA', last_name: 'Guest' });

    const [reservationId] = await db()('reservations').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      guest_id: guestId,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: '2028-01-01',
      departure_date: '2029-01-01',
      adults: 1,
      children: 0,
      status: 'checked_in',
      confirmation_number: `NARACE${suffix}`.toUpperCase().slice(0, 26),
      checked_in_at: new Date(),
    });
    await db()('reservation_daily_rates').insert(
      ['2028-01-01', '2028-01-02', '2028-01-03'].map((stayDate) => ({
        tenant_id: tenantId,
        property_id: propertyId,
        reservation_id: reservationId,
        stay_date: stayDate,
        rate: '120.00',
        currency: 'NGN',
      }))
    );
    await db()('reservation_rooms').insert({ tenant_id: tenantId, property_id: propertyId, reservation_id: reservationId, room_id: roomId, effective_from: new Date(), effective_to: null });
    [folioId] = await db()('folios').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `NARACEFOLIO${suffix}`.toUpperCase().slice(0, 26),
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
    });

    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('daily_reports').where({ property_id: propertyId }).delete();
    await db()('night_audit_runs').where({ property_id: propertyId }).delete();
    await db()('outbox_events').where({ tenant_id: tenantId }).delete();
    await db()('folio_line_items').where({ tenant_id: tenantId }).delete();
    await db()('folios').where({ tenant_id: tenantId }).delete();
    await db()('reservation_rooms').where({ tenant_id: tenantId }).delete();
    await db()('reservation_daily_rates').where({ tenant_id: tenantId }).delete();
    await db()('reservations').where({ tenant_id: tenantId }).delete();
    await db()('rate_codes').where({ tenant_id: tenantId }).delete();
    await db()('rooms').where({ tenant_id: tenantId }).delete();
    await db()('room_types').where({ tenant_id: tenantId }).delete();
    await db()('guests').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  it('NA-2: two genuinely concurrent triggers for the same property + business date — exactly one succeeds, no duplicate charge', async () => {
    const trigger = () => req.post('/api/v1/night-audit/run').set('Authorization', `Bearer ${token}`).send({});

    const [first, second] = await Promise.all([trigger(), trigger()]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);

    // Whichever request's INSERT wins the unique-constraint race gets a 200;
    // the other sees the row already exists and refuses — 409 either way
    // (CONFLICT_NIGHT_AUDIT_ALREADY_RUNNING is the expected shape; a
    // genuinely fast winner could in principle already be COMPLETED by the
    // time the loser's own reconcile step runs, which is still 409).
    expect(statuses).toEqual([200, 409]);

    const runs = await db()('night_audit_runs').where({ property_id: propertyId, business_date: '2028-01-01' });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('COMPLETED');

    const chargeLines = await db()('folio_line_items').where({ folio_id: folioId, type: 'room_charge' });
    expect(chargeLines).toHaveLength(1);

    const dailyReports = await db()('daily_reports').where({ property_id: propertyId, business_date: '2028-01-01' });
    expect(dailyReports).toHaveLength(1);

    const property = await db()('properties').where({ id: propertyId }).first();
    expect(property.current_business_date).toBe('2028-01-02');
  });

  it('NA-3: a stale RUNNING row (worker died, transaction never committed) is recovered and a fresh trigger completes cleanly', async () => {
    // Simulate a crash: a RUNNING row with NO corresponding daily_reports
    // row and a heartbeat far in the past — exactly what a dead worker
    // leaves behind (ARCHITECTURE.md §6.3's "the transaction never
    // committed" case).
    await db()('night_audit_runs').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      business_date: '2028-01-02',
      status: 'RUNNING',
      worker_id: 'dead-worker-simulated',
      heartbeat_at: new Date(Date.now() - 5 * 60 * 1000),
      started_at: new Date(Date.now() - 5 * 60 * 1000),
      run_by_user_id: userId,
    });

    const res = await req.post('/api/v1/night-audit/run').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.meta.run.status).toBe('COMPLETED');

    const runs = await db()('night_audit_runs').where({ property_id: propertyId, business_date: '2028-01-02' });
    expect(runs).toHaveLength(1); // The stale row was RECLAIMED, not duplicated.
    expect(runs[0].status).toBe('COMPLETED');
    expect(runs[0].worker_id).not.toBe('dead-worker-simulated');

    const chargeLines = await db()('folio_line_items').where({ folio_id: folioId, type: 'room_charge', business_date: '2028-01-02' });
    expect(chargeLines).toHaveLength(1); // Exactly once — no duplicate from the "dead" attempt, which never posted anything.
  });

  it('a RUNNING row that is NOT yet stale refuses a concurrent trigger outright', async () => {
    await db()('night_audit_runs').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      business_date: '2028-01-03',
      status: 'RUNNING',
      worker_id: 'still-alive-worker',
      heartbeat_at: new Date(),
      started_at: new Date(),
      run_by_user_id: userId,
    });

    const res = await req.post('/api/v1/night-audit/run').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_NIGHT_AUDIT_ALREADY_RUNNING');

    await db()('night_audit_runs').where({ property_id: propertyId, business_date: '2028-01-03' }).delete();
  });
});
