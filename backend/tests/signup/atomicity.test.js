'use strict';

// Real pooled connections, not the shared-transaction-per-file harness — a
// nested `.transaction()` call against an already-open trx is a no-op reuse
// of that SAME trx (`scoped-db.js`'s own documented behaviour), so it
// cannot prove genuine rollback. The identical distinction
// `tests/platform/atomicity.test.js` already draws from
// `tests/platform/platform.test.js`.
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');

let mockFailHashAt = null;
jest.mock('../../src/auth', () => {
  const actual = jest.requireActual('../../src/auth');
  return {
    ...actual,
    hashPassword: async (plaintext) => {
      if (mockFailHashAt) throw new Error('Injected hashing failure');
      return actual.hashPassword(plaintext);
    },
  };
});

const service = require('../../src/modules/signup/service');

describe('signup atomicity on real MySQL connections (ARCHITECTURE.md §4)', () => {
  beforeAll(() => {
    dbModule.__setConnectionForTesting(db());
  });
  afterEach(() => {
    mockFailHashAt = null;
  });
  afterAll(async () => {
    dbModule.__resetForTesting();
  });

  function validInput(overrides = {}) {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return {
      companyName: 'Atomic Hotels',
      slug: `atomic-${unique}`,
      timezone: 'Africa/Lagos',
      baseCurrency: 'NGN',
      adminEmail: `owner-${unique}@atomic.example`,
      adminPassword: 'a genuinely long enough password',
      adminFirstName: 'Ada',
      adminLastName: 'Okafor',
      ...overrides,
    };
  }

  async function cleanupTenant(slug) {
    const tenant = await db()('tenants').where({ slug }).first('id');
    if (!tenant) return;
    await db()('user_property_access').where({ tenant_id: tenant.id }).delete();
    await db()('role_permissions').where({ tenant_id: tenant.id }).delete();
    await db()('roles').where({ tenant_id: tenant.id }).delete();
    await db()('sessions').whereIn('user_id', db()('users').where({ tenant_id: tenant.id }).select('id')).delete();
    await db()('audit_log').where({ tenant_id: tenant.id }).delete();
    // auth_events.user_id -> users(tenant_id, id), RESTRICT — issueStaffSession's
    // real login_success row (written after the transaction commits) must go
    // before users below, or the delete fails with a real FK violation.
    await db()('auth_events').where({ tenant_id: tenant.id }).delete();
    await db()('tenant_signups').where({ tenant_id: tenant.id }).delete();
    await db()('users').where({ tenant_id: tenant.id }).delete();
    await db()('properties').where({ tenant_id: tenant.id }).delete();
    await db()('tenants').where({ id: tenant.id }).delete();
  }

  it('failure during tenant creation (a real slug collision) leaves nothing partial', async () => {
    const first = validInput();
    await service.signupTenant(first);

    try {
      const second = validInput({ slug: first.slug });
      await expect(service.signupTenant(second)).rejects.toThrow();

      const tenantsWithSlug = await db()('tenants').where({ slug: first.slug });
      expect(tenantsWithSlug).toHaveLength(1); // exactly the first, real one — no duplicate, no partial second row
      const usersWithSecondEmail = await db()('users').where({ email: second.adminEmail.toLowerCase() });
      expect(usersWithSecondEmail).toHaveLength(0);
    } finally {
      await cleanupTenant(first.slug);
    }
  });

  it('failure during admin-user creation rolls back the tenant (and the roles/permissions already inserted with it)', async () => {
    const input = validInput();
    mockFailHashAt = true;

    await expect(service.signupTenant(input)).rejects.toThrow('Injected hashing failure');

    const tenants = await db()('tenants').where({ slug: input.slug });
    expect(tenants).toHaveLength(0);
    const signups = await db()('tenant_signups').where({ email: input.adminEmail.toLowerCase() });
    expect(signups).toHaveLength(0); // the tenant_signups row inserted before the failure is gone too
    const users = await db()('users').where({ email: input.adminEmail.toLowerCase() });
    expect(users).toHaveLength(0);
  });

  it('failure during property creation rolls back the tenant AND the admin user already created', async () => {
    // properties.timezone is VARCHAR(64); MySQL 8's default strict mode
    // rejects a value that doesn't fit rather than silently truncating —
    // a real constraint violation, not a mock, at exactly the property
    // insert step (which happens AFTER the admin user in this module's own
    // deliberate ordering — see service.js's own header comment).
    const input = validInput({ timezone: 'X'.repeat(100) });

    await expect(service.signupTenant(input)).rejects.toThrow();

    const tenants = await db()('tenants').where({ slug: input.slug });
    expect(tenants).toHaveLength(0);
    const users = await db()('users').where({ email: input.adminEmail.toLowerCase() });
    expect(users).toHaveLength(0);
    // No separate `properties` check by name: `properties.tenant_id` carries
    // a RESTRICT foreign key to `tenants` — a property row for THIS attempt
    // could not exist without the tenant existing too, and the tenant
    // assertion above already covers that. Querying by name here would also
    // be genuinely ambiguous, since every call to validInput() shares the
    // same company name across tests.
  });

  it('a fully successful signup leaves exactly the expected rows, and only those', async () => {
    const input = validInput();
    const result = await service.signupTenant(input);

    try {
      expect(await db()('tenants').where({ id: result.tenantId })).toHaveLength(1);
      expect(await db()('properties').where({ id: result.propertyId })).toHaveLength(1);
      expect(await db()('users').where({ id: result.userId })).toHaveLength(1);
      expect(await db()('roles').where({ tenant_id: result.tenantId })).toHaveLength(7);
      expect(await db()('user_property_access').where({ user_id: result.userId, property_id: result.propertyId })).toHaveLength(1);
      expect(await db()('tenant_signups').where({ email: input.adminEmail.toLowerCase() })).toHaveLength(1);
    } finally {
      await cleanupTenant(input.slug);
    }
  });
});
