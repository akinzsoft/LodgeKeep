'use strict';

/**
 * Real pooled connections, not the shared-transaction-per-file harness —
 * the same distinction every other sweep-correctness suite in this
 * codebase already draws (tests/jobs/trial-expiry-sweep.test.js,
 * tests/jobs/subscription-billing-sweep.test.js). Proves
 * `runDoorAccessRetentionSweep` (PLAN.md Phase 7 gap closure) end to end:
 * which properties it touches, that it purges only unreferenced old
 * events, that it writes a real audit row, and that it's safe under
 * genuine concurrent execution.
 *
 * `access-monitoring/service.js`'s own `purgeExpiredEvents` (the "does it
 * correctly distinguish an alert-referenced event from a stay-confirmation-
 * referenced one" nuance) is covered more thoroughly in
 * tests/access-monitoring/retention.test.js, which has cheap access to a
 * full reservation via the shared-transaction harness's `seedStay`
 * helper — this file only needs one referenced case to prove the sweep's
 * own iteration/audit/concurrency mechanics.
 */

const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { runDoorAccessRetentionSweep } = require('../../src/jobs/door-access-retention');

describe('runDoorAccessRetentionSweep (PLAN.md Phase 7 gap closure, real MySQL)', () => {
  const tenantIds = [];

  beforeAll(() => {
    dbModule.__setConnectionForTesting(db());
  });

  afterEach(async () => {
    while (tenantIds.length) {
      const id = tenantIds.pop();
      await db()('audit_log').where({ tenant_id: id }).delete();
      await db()('access_alert_events').where({ tenant_id: id }).delete();
      await db()('access_alerts').where({ tenant_id: id }).delete();
      await db()('door_access_events').where({ tenant_id: id }).delete();
      await db()('lock_system_config').where({ tenant_id: id }).delete();
      await db()('rooms').where({ tenant_id: id }).delete();
      await db()('room_types').where({ tenant_id: id }).delete();
      await db()('users').where({ tenant_id: id }).delete();
      await db()('properties').where({ tenant_id: id }).delete();
      await db()('tenants').where({ id }).delete();
    }
  });

  afterAll(() => {
    dbModule.__resetForTesting();
  });

  /** A tenant with one property, one room, and one lock_system_config row. */
  async function makeProperty({ retentionDays = null } = {}) {
    const slug = `retention-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [tenantId] = await db()('tenants').insert({ name: 'Retention Sweep Test Hotels', slug, status: 'active' });
    tenantIds.push(tenantId);

    const [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `${slug}-prop`,
      name: 'Retention Sweep Test Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      status: 'active',
    });

    const [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `retention-${slug}@example.test`,
      password_hash: 'x',
      first_name: 'Retention',
      last_name: 'Tester',
    });

    const [roomTypeId] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'RETTYPE',
      name: 'Retention test',
      default_occupancy: 2,
      base_rate: '100.00',
    });

    const [roomId] = await db()('rooms').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      room_type_id: roomTypeId,
      room_number: '01',
    });

    await db()('lock_system_config').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      adapter: 'hiread_prousb',
      ingestion_mode: 'manual_import',
      retention_days: retentionDays,
    });

    return { tenantId, propertyId, roomId, userId };
  }

  async function makeEvent({ tenantId, propertyId, roomId, userId, openedAt, cardId = 'CARD1' }) {
    const [id] = await db()('door_access_events').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      room_id: roomId,
      lock_system: 'hiread_prousb',
      card_id: cardId,
      is_guest_card: true,
      opened_at: openedAt,
      import_ref: `import-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      imported_by_user_id: userId,
    });
    return id;
  }

  /** Raises a real alert referencing `eventId` as its evidence — this is what makes an event survive the purge regardless of age. */
  async function makeReferencedAlert({ tenantId, propertyId, roomId, eventId, openedAt }) {
    const [alertId] = await db()('access_alerts').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      room_id: roomId,
      card_id: 'CARD1',
      rule: 'unsold_occupancy',
      severity: 'critical',
      evidence: JSON.stringify({ note: 'test evidence' }),
      business_date: openedAt.toISOString().slice(0, 10),
      first_event_at: openedAt,
      last_event_at: openedAt,
      event_count: 1,
    });
    await db()('access_alert_events').insert({ tenant_id: tenantId, property_id: propertyId, access_alert_id: alertId, door_access_event_id: eventId });
    return alertId;
  }

  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it('purges unreferenced events older than the configured retention window, leaves newer ones, and skips a property with no window set', async () => {
    const configured = await makeProperty({ retentionDays: 30 });
    const oldUnreferencedId = await makeEvent({ ...configured, openedAt: daysAgo(45) });
    const oldReferencedId = await makeEvent({ ...configured, openedAt: daysAgo(60), cardId: 'CARD2' });
    await makeReferencedAlert({ ...configured, eventId: oldReferencedId, openedAt: daysAgo(60) });
    const recentId = await makeEvent({ ...configured, openedAt: daysAgo(5), cardId: 'CARD3' });

    const unconfigured = await makeProperty({ retentionDays: null });
    const untouchedId = await makeEvent({ ...unconfigured, openedAt: daysAgo(9999) });

    const totalDeleted = await runDoorAccessRetentionSweep();

    expect(totalDeleted).toBeGreaterThanOrEqual(1);
    expect(await db()('door_access_events').where({ id: oldUnreferencedId }).first()).toBeUndefined();
    expect(await db()('door_access_events').where({ id: oldReferencedId }).first()).toBeTruthy();
    expect(await db()('door_access_events').where({ id: recentId }).first()).toBeTruthy();
    // A property with retention_days = null is never even considered.
    expect(await db()('door_access_events').where({ id: untouchedId }).first()).toBeTruthy();

    const entry = await db()('audit_log').where({ tenant_id: configured.tenantId, action: 'door_access_retention_purge' }).first();
    expect(entry).toBeTruthy();
    expect(entry.source).toBe('job');
    expect(String(entry.property_id)).toBe(String(configured.propertyId));
    expect(entry.after_state).toMatchObject({ deletedCount: 1, retentionDays: 30 });
    expect(await db()('audit_log').where({ tenant_id: unconfigured.tenantId, action: 'door_access_retention_purge' })).toHaveLength(0);
  });

  it('is idempotent — a second sweep deletes nothing further and writes no duplicate audit row', async () => {
    const configured = await makeProperty({ retentionDays: 10 });
    await makeEvent({ ...configured, openedAt: daysAgo(20) });

    const first = await runDoorAccessRetentionSweep();
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await runDoorAccessRetentionSweep();
    expect(second).toBe(0);

    expect(await db()('door_access_events').where({ tenant_id: configured.tenantId })).toHaveLength(0);
    expect(await db()('audit_log').where({ tenant_id: configured.tenantId, action: 'door_access_retention_purge' })).toHaveLength(1);
  });

  it('two genuinely concurrent sweeps over the same overdue events cause no error and delete each exactly once', async () => {
    const configured = await makeProperty({ retentionDays: 10 });
    await makeEvent({ ...configured, openedAt: daysAgo(20) });
    await makeEvent({ ...configured, openedAt: daysAgo(25), cardId: 'CARD2' });

    await Promise.all([runDoorAccessRetentionSweep(), runDoorAccessRetentionSweep()]);

    expect(await db()('door_access_events').where({ tenant_id: configured.tenantId })).toHaveLength(0);
  });
});
