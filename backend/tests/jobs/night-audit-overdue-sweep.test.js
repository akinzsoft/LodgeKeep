'use strict';

/**
 * Real pooled connections, not the shared-transaction-per-file harness —
 * the same distinction every other sweep-correctness suite in this
 * codebase already draws (`tests/jobs/door-access-retention-sweep.test.js`,
 * `tests/jobs/trial-expiry-sweep.test.js`). Proves `runNightAuditOverdueSweep`
 * (gap closure, user-requested) end to end: which properties it flags,
 * that it writes a real bell row, a real outbox email row per
 * manager/admin/super_admin, and a real audit row; that a second tick is a
 * genuine no-op for the same stale date; and that it's safe under real
 * concurrent execution.
 *
 * `current_business_date` values are chosen far in the past (`2020-01-01`)
 * or far in the future (`2099-01-01`) rather than "yesterday"/"today" —
 * the same discipline `tests/night-audit/business-date-timezone.test.js`
 * already uses, so this test's own outcome never depends on what day it
 * actually runs.
 */

const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { runNightAuditOverdueSweep, overdueDedupKey } = require('../../src/jobs/night-audit-overdue');

describe('runNightAuditOverdueSweep (gap closure, real MySQL)', () => {
  const tenantIds = [];

  beforeAll(() => {
    dbModule.__setConnectionForTesting(db());
  });

  afterEach(async () => {
    while (tenantIds.length) {
      const id = tenantIds.pop();
      await db()('audit_log').where({ tenant_id: id }).delete();
      await db()('outbox_events').where({ tenant_id: id }).delete();
      await db()('in_app_notifications').where({ tenant_id: id }).delete();
      await db()('user_property_access').where({ tenant_id: id }).delete();
      await db()('users').where({ tenant_id: id }).delete();
      await db()('roles').where({ tenant_id: id }).delete();
      await db()('properties').where({ tenant_id: id }).delete();
      await db()('tenants').where({ id }).delete();
    }
  });

  afterAll(() => {
    dbModule.__resetForTesting();
  });

  /** A tenant with one property and, optionally, one manager granted at it. */
  async function makeProperty({ currentBusinessDate, grantManager = true, timezone = 'Africa/Lagos' } = {}) {
    const slug = `na-overdue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [tenantId] = await db()('tenants').insert({ name: 'NA Overdue Sweep Test Hotels', slug, status: 'active' });
    tenantIds.push(tenantId);

    const [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `${slug}-prop`,
      name: 'NA Overdue Sweep Test Property',
      timezone,
      base_currency: 'NGN',
      status: 'active',
      current_business_date: currentBusinessDate,
    });

    let userId = null;
    let userEmail = null;
    if (grantManager) {
      await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
      userEmail = `manager-${slug}@example.test`;
      [userId] = await db()('users').insert({
        tenant_id: tenantId,
        email: userEmail,
        password_hash: 'x',
        first_name: 'Manager',
        last_name: 'Tester',
        status: 'active',
      });
      await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });
    }

    return { tenantId, propertyId, userId, userEmail, propertyName: 'NA Overdue Sweep Test Property' };
  }

  it('flags a property whose business date is stale — real bell, real outbox email, real audit row, exactly once', async () => {
    const overdue = await makeProperty({ currentBusinessDate: '2020-01-01' });
    const current = await makeProperty({ currentBusinessDate: '2099-01-01' });

    const alertedCount = await runNightAuditOverdueSweep();
    expect(alertedCount).toBeGreaterThanOrEqual(1);

    const bell = await db()('in_app_notifications').where({
      tenant_id: overdue.tenantId,
      user_id: overdue.userId,
      dedup_key: overdueDedupKey(overdue.propertyId, '2020-01-01'),
    });
    expect(bell).toHaveLength(1);
    expect(bell[0].type).toBe('night_audit.overdue');

    const outboxRow = await db()('outbox_events').where({ tenant_id: overdue.tenantId, event_type: 'night_audit.overdue' }).first();
    expect(outboxRow).toBeTruthy();
    expect(String(outboxRow.property_id)).toBe(String(overdue.propertyId));
    const payload = typeof outboxRow.payload === 'string' ? JSON.parse(outboxRow.payload) : outboxRow.payload;
    expect(payload).toMatchObject({ recipientEmail: overdue.userEmail, businessDate: '2020-01-01', propertyName: overdue.propertyName });

    const auditRow = await db()('audit_log').where({ tenant_id: overdue.tenantId, action: 'night_audit_overdue_alerted' }).first();
    expect(auditRow).toBeTruthy();
    expect(auditRow.source).toBe('job');
    expect(String(auditRow.property_id)).toBe(String(overdue.propertyId));
    expect(auditRow.after_state).toMatchObject({ businessDate: '2020-01-01', recipientCount: 1 });

    // The far-future property is genuinely untouched — never even a candidate.
    expect(await db()('outbox_events').where({ tenant_id: current.tenantId })).toHaveLength(0);
    expect(await db()('audit_log').where({ tenant_id: current.tenantId })).toHaveLength(0);
  });

  it('is idempotent — a second tick for the same stale date sends nothing further', async () => {
    const overdue = await makeProperty({ currentBusinessDate: '2020-01-01' });

    const first = await runNightAuditOverdueSweep();
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await runNightAuditOverdueSweep();
    expect(second).toBe(0);

    expect(await db()('outbox_events').where({ tenant_id: overdue.tenantId })).toHaveLength(1);
    expect(await db()('audit_log').where({ tenant_id: overdue.tenantId, action: 'night_audit_overdue_alerted' })).toHaveLength(1);
  });

  it('a property with no manager/admin/super_admin granted still writes a real audit row with zero recipients, no crash', async () => {
    const overdue = await makeProperty({ currentBusinessDate: '2020-01-01', grantManager: false });

    await runNightAuditOverdueSweep();

    const auditRow = await db()('audit_log').where({ tenant_id: overdue.tenantId, action: 'night_audit_overdue_alerted' }).first();
    expect(auditRow).toBeTruthy();
    expect(auditRow.after_state).toMatchObject({ recipientCount: 0 });
    expect(await db()('outbox_events').where({ tenant_id: overdue.tenantId })).toHaveLength(0);
  });

  it('two genuinely concurrent sweeps over the same stale property alert exactly once', async () => {
    const overdue = await makeProperty({ currentBusinessDate: '2020-01-01' });

    await Promise.all([runNightAuditOverdueSweep(), runNightAuditOverdueSweep()]);

    expect(await db()('outbox_events').where({ tenant_id: overdue.tenantId })).toHaveLength(1);
    expect(await db()('audit_log').where({ tenant_id: overdue.tenantId, action: 'night_audit_overdue_alerted' })).toHaveLength(1);
  });
});
