'use strict';

/**
 * Door access monitoring under REAL concurrent connections (ARCHITECTURE.md
 * §5). The shared-transaction harness every other suite uses cannot prove a
 * lock — two "concurrent" requests there are savepoints on one MySQL session,
 * which never blocks itself — so this file binds the app to the pooled test
 * connection and seeds committed rows it cleans up itself, the same harness
 * class as tests/reservations/concurrency.test.js.
 *
 * 1. Two overlapping lock-log uploads for the same property, fired at once,
 *    must yield each door event exactly once and ONE incident holding all of
 *    them — not a duplicate-key 500, and not two split incidents. The
 *    mechanism is the `lock_system_config` row lock taken first in
 *    commitImport; removing that `.forUpdate()` makes this test fail.
 * 2. Two simultaneous resolves of one alert: exactly one succeeds.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

const MAPPING = JSON.stringify({ roomColumn: 'Door', cardColumn: 'Card', timestampColumn: 'Time', timestampFormat: 'YYYY-MM-DD HH:mm:ss' });

describe('door access monitoring under real concurrent connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let roomTypeId;
  let token;
  let secondPropertyId;
  let secondToken;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Door Race Tenant', slug: `door-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `door-race-property-${suffix}`,
      name: 'Door Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    const [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `door-race-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Door',
      last_name: 'Race',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });
    const perms = await db()('permissions').whereIn('permission_key', ['door_access.view', 'door_access.manage']).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [roomTypeId] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'RACE',
      name: 'Race',
      default_occupancy: 2,
      base_rate: '100.00',
    });
    await db()('lock_system_config').insert({ tenant_id: tenantId, property_id: propertyId, adapter: 'hiread_prousb', ingestion_mode: 'manual_import' });

    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });

    // A second property with NO lock_system_config row yet, for the
    // first-time-save race.
    [secondPropertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `door-race-second-${suffix}`,
      name: 'Door Race Second',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: secondPropertyId, user_id: userId, role: 'manager' });
    secondToken = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(secondPropertyId) });
  });

  afterAll(async () => {
    for (const table of [
      'in_app_notifications',
      'outbox_events',
      'audit_log',
      'access_alert_events',
      'door_access_stay_confirmations',
      'access_alerts',
      'door_access_events',
      'lock_system_config',
      'rooms',
      'room_types',
      'user_property_access',
      'role_permissions',
      'users',
      'roles',
      'properties',
    ]) {
      await db()(table).where({ tenant_id: tenantId }).delete();
    }
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  const upload = (lines) =>
    req
      .post('/api/v1/door-access/imports/commit')
      .set('Authorization', `Bearer ${token}`)
      .field('mapping', MAPPING)
      .attach('file', Buffer.from(['Door,Card,Time', ...lines].join('\n')), 'audit.csv');

  it('overlapping uploads fired at once store each event once and group them into ONE incident', async () => {
    // Several rounds, each on a fresh room: without the lock the race is
    // timing-dependent, so one round could pass by luck.
    for (let round = 0; round < 6; round += 1) {
      const roomNumber = `RACE-${round}`;
      const [roomId] = await db()('rooms').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: roomTypeId, room_number: roomNumber });
      const day = `2026-04-${String(round + 1).padStart(2, '0')}`;
      const fileA = [`${roomNumber},CARD-X,${day} 01:00:00`, `${roomNumber},CARD-X,${day} 02:00:00`];
      const fileB = [`${roomNumber},CARD-X,${day} 02:00:00`, `${roomNumber},CARD-X,${day} 03:00:00`];

      const [a, b] = await Promise.all([upload(fileA), upload(fileB)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.data.alertsCreated + b.body.data.alertsCreated).toBe(1);

      const events = await db()('door_access_events').where({ tenant_id: tenantId, room_id: roomId });
      expect(events).toHaveLength(3);
      const alerts = await db()('access_alerts').where({ tenant_id: tenantId, room_id: roomId });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].event_count).toBe(3);
      const links = await db()('access_alert_events').where({ tenant_id: tenantId, access_alert_id: alerts[0].id });
      expect(links).toHaveLength(3);
    }
  });

  it('two simultaneous FIRST-TIME settings saves for a property both succeed and leave exactly one config row (code-review regression)', async () => {
    const save = (adapter) =>
      req.put('/api/v1/door-access/config').set('Authorization', `Bearer ${secondToken}`).send({ adapter });
    const results = await Promise.all([save('hiread_prousb'), save('generic_csv')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await db()('lock_system_config').where({ tenant_id: tenantId, property_id: secondPropertyId });
    expect(rows).toHaveLength(1);
    expect(['hiread_prousb', 'generic_csv']).toContain(rows[0].adapter);
  });

  it('two simultaneous resolves of one alert: exactly one succeeds', async () => {
    const [alert] = await db()('access_alerts').where({ tenant_id: tenantId, status: 'open' }).limit(1);
    const resolve = (reason) =>
      req.post(`/api/v1/door-access/alerts/${alert.id}/resolve`).set('Authorization', `Bearer ${token}`).send({ reason });

    const results = await Promise.all([resolve('first'), resolve('second')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const stored = await db()('access_alerts').where({ id: alert.id }).first();
    expect(stored.status).toBe('resolved');
    const audits = await db()('audit_log').where({ tenant_id: tenantId, entity_type: 'access_alerts', entity_id: alert.id, action: 'resolve' });
    expect(audits).toHaveLength(1);
  });
});
