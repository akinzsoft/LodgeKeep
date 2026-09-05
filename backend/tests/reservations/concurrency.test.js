'use strict';

/**
 * RES-5 (TESTING.md): "Two concurrent requests for the last room — exactly
 * one succeeds, other fails cleanly, no partial write." ARCHITECTURE.md §5's
 * canonical race, pulled forward per PLAN.md's own instruction for this phase.
 *
 * ── WHY THIS FILE DOES NOT USE `useTestApp()` ───────────────────────────
 *
 * Every other test file in this suite runs against ONE shared, rolled-back
 * transaction (`tests/helpers/app.js`'s `useTestApp`) — fast, and correct
 * for everything that isn't testing lock contention itself. But two
 * "concurrent" requests bound to that single transaction are really two
 * SAVEPOINTs on the same MySQL session, and a session's own locks never
 * block itself (`tests/isolation/scoped-accessor.test.js`'s own comment on
 * its read-only "opens a real transaction" test names this exact
 * limitation: "a write from a second connection would block ... which is
 * InnoDB behaving correctly, not a bug in the accessor" — it deliberately
 * stops short of a live two-writer race for the same reason). Proving RES-5
 * for real needs two genuinely separate connections, which needs this
 * file's own setup instead: `dbModule.__setConnectionForTesting(db())`
 * binds the app to the real POOLED connection (`knexfile.js`'s
 * `test.pool: { min: 1, max: 5 }` — sized deliberately, per its own
 * comment, "a single-connection pool would serialise the last-room race
 * and make it pass vacuously"), not a single transaction, and this file
 * seeds real COMMITTED fixture rows (cleaned up in `afterAll`) rather than
 * relying on rollback, since nothing here is inside one transaction to roll
 * back.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

describe('RES-5: the last-room race under real concurrent connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let roomTypeId;
  let guestId;
  let rateCodeId;
  let userId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    [tenantId] = await db()('tenants').insert({ name: 'Concurrency Tenant', slug: `concurrency-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `concurrency-property-${suffix}`,
      name: 'Concurrency Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `concurrency-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Concurrency',
      last_name: 'User',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });

    // reservations.view/manage are migration-seeded globally (20260906098000) — grant, don't create.
    const perms = await db()('permissions').whereIn('permission_key', ['reservations.view', 'reservations.manage']).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [roomTypeId] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'RACE',
      name: 'Race',
      default_occupancy: 2,
      base_rate: '100.00',
    });
    await db()('rooms').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: roomTypeId, room_number: '1' });
    [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'Race', last_name: 'Guest' });
    [rateCodeId] = await db()('rate_codes').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'RACERATE',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
  });

  afterAll(async () => {
    // Committed rows, not a rolled-back transaction — clean up child-to-parent.
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    // PLAN.md Phase 3: booking through the real HTTP layer now also commits
    // an outbox_events row (ARCHITECTURE.md section 13) — a child of
    // `properties` via its own (tenant_id, property_id) FK, so it must be
    // cleaned up before `properties` below.
    await db()('outbox_events').where({ tenant_id: tenantId }).delete();
    await db()('idempotency_keys').where({ tenant_id: tenantId }).delete();
    await db()('reservation_daily_rates').where({ tenant_id: tenantId }).delete();
    await db()('room_type_inventory').where({ tenant_id: tenantId }).delete();
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

  it('exactly one of two truly concurrent bookings for the one physical room succeeds; the other fails cleanly with no partial write', async () => {
    const token = signAccessToken({
      aud: 'staff',
      sub: String(userId),
      tenant_id: String(tenantId),
      property_id: String(propertyId),
    });

    const book = (key) =>
      req
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({
          guest_id: String(guestId),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2029-01-01',
          departure_date: '2029-01-02',
        });

    const [first, second] = await Promise.all([book('race-key-1'), book('race-key-2')]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 422]);

    const winner = first.status === 201 ? first : second;
    const loser = first.status === 201 ? second : first;
    expect(winner.body.data.status).toBe('confirmed');
    expect(loser.body.error.code).toBe('BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED');

    // No partial write: exactly one row sold, exactly one reservation.
    const inventoryRow = await db()('room_type_inventory')
      .where({ tenant_id: tenantId, room_type_id: roomTypeId, stay_date: '2029-01-01' })
      .first();
    expect(inventoryRow.rooms_sold).toBe(1);

    const reservationCount = await db()('reservations')
      .where({ tenant_id: tenantId, status: 'confirmed' })
      .count({ n: '*' })
      .first();
    expect(Number(reservationCount.n)).toBe(1);
  });
});
