'use strict';

// Real pooled connections, not the shared-transaction-per-file harness —
// the identical distinction `tests/platform/atomicity.test.js` and
// `tests/signup/atomicity.test.js` already draw against their own
// service functions.
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { platformContext } = require('../../src/modules/tenancy');
const { seedPlatformUser } = require('../helpers/fixtures');

let mockFailAudit = null;
jest.mock('../../src/audit', () => {
  const actual = jest.requireActual('../../src/audit');
  return {
    ...actual,
    recordAuditEntry: async (...args) => {
      if (mockFailAudit) throw new Error('Injected audit failure');
      return actual.recordAuditEntry(...args);
    },
  };
});

const service = require('../../src/modules/platform/service');

describe('tenant suspend/reactivate atomicity on real MySQL connections (ARCHITECTURE.md §4)', () => {
  let platformUser;
  let tenantId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    platformUser = await seedPlatformUser(db(), `lifecycle-atomic-${Date.now()}@planmsys.test`, 'admin');
    [tenantId] = await db()('tenants').insert({ name: 'Atomic Lifecycle Hotels', slug: `atomic-lifecycle-${Date.now()}`, status: 'active' });
  });
  afterEach(() => {
    mockFailAudit = null;
  });
  afterAll(async () => {
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    await db()('platform_users').where({ id: platformUser.id }).delete();
    dbModule.__resetForTesting();
  });

  const context = () => platformContext({ platformUserId: platformUser.id, role: 'admin' });

  it('rolls back both the status change and its audit record when the audit write fails (suspend)', async () => {
    await expect(
      (async () => {
        mockFailAudit = true;
        return service.suspendTenant({ context: context(), tenantId, reason: 'Should not stick' });
      })()
    ).rejects.toThrow('Injected audit failure');

    const tenant = await db()('tenants').where({ id: tenantId }).first();
    expect(tenant.status).toBe('active'); // NOT suspended — the whole transaction rolled back
    const entries = await db()('audit_log').where({ tenant_id: tenantId, action: 'suspend' });
    expect(entries).toHaveLength(0);
  });

  it('rolls back both the status change and its audit record when the audit write fails (reactivate), then commits both on retry', async () => {
    // First, a real, committed suspend (no injected failure) to have
    // something to reactivate.
    await service.suspendTenant({ context: context(), tenantId, reason: 'Setting up the reactivate test' });

    mockFailAudit = true;
    await expect(service.reactivateTenant({ context: context(), tenantId, reason: 'Should not stick' })).rejects.toThrow('Injected audit failure');

    let tenant = await db()('tenants').where({ id: tenantId }).first();
    expect(tenant.status).toBe('suspended'); // NOT active — rolled back
    expect(await db()('audit_log').where({ tenant_id: tenantId, action: 'reactivate' })).toHaveLength(0);

    mockFailAudit = null;
    const result = await service.reactivateTenant({ context: context(), tenantId, reason: 'Real retry' });
    expect(result.status).toBe('active');

    tenant = await db()('tenants').where({ id: tenantId }).first();
    expect(tenant.status).toBe('active');
    expect(await db()('audit_log').where({ tenant_id: tenantId, action: 'reactivate' })).toHaveLength(1);
  });

  it('two genuinely concurrent suspend attempts against the same tenant resolve to exactly one transition and one audit row', async () => {
    await db()('tenants').where({ id: tenantId }).update({ status: 'active' });
    // Earlier tests in this file leave their own real, committed "suspend"
    // audit_log rows for this same tenant — scope this test's own
    // assertion to rows created from here on, not the count since the
    // start of the file.
    const priorSuspendRows = await db()('audit_log').where({ tenant_id: tenantId, action: 'suspend' }).max('id as maxId');
    const sinceId = priorSuspendRows[0]?.maxId ?? 0;

    const results = await Promise.allSettled([
      service.suspendTenant({ context: context(), tenantId, reason: 'Racer 1' }),
      service.suspendTenant({ context: context(), tenantId, reason: 'Racer 2' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one succeeds (the conditional UPDATE's WHERE status IN (...)
    // means the second racer's own attempt affects zero rows once the
    // first has already committed 'suspended').
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('VALIDATION_INVALID_TENANT_TRANSITION');

    const tenant = await db()('tenants').where({ id: tenantId }).first();
    expect(tenant.status).toBe('suspended');
    expect(await db()('audit_log').where({ tenant_id: tenantId, action: 'suspend' }).where('id', '>', sinceId)).toHaveLength(1);
  });
});
