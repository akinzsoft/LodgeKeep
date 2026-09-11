'use strict';

// Real pooled connections: a shared rolled-back fixture transaction cannot
// prove either rollback of a service-owned transaction or lock contention.
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { platformContext, impersonationContext } = require('../../src/modules/tenancy');
const { seedPlatformUser } = require('../helpers/fixtures');
let mockFailEvent = null;
jest.mock('../../src/auth/events', () => ({
  writeAuthEvent: async (...args) => {
    const result = await jest.requireActual('../../src/auth/events').writeAuthEvent(...args);
    if (args[0].eventType === mockFailEvent) throw new Error('Injected audit failure');
    return result;
  },
}));
const service = require('../../src/modules/platform/service');

describe('platform lifecycle atomicity on real MySQL connections', () => {
  let user;
  let tenantId;
  let propertyId;
  let context;
  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    user = await seedPlatformUser(db());
    [tenantId] = await db()('tenants').insert({ name: 'Atomic support', slug: `atomic-support-${Date.now()}` });
    [propertyId] = await db()('properties').insert({ tenant_id: tenantId, slug: 'atomic', name: 'Atomic property', timezone: 'Europe/London', base_currency: 'GBP' });
    context = platformContext({ platformUserId: user.id });
  });
  afterEach(() => { mockFailEvent = null; });
  afterAll(async () => {
    await db()('auth_events').where({ platform_user_id: user.id }).delete();
    await db()('impersonation_sessions').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ id: propertyId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    await db()('platform_users').where({ id: user.id }).delete();
    dbModule.__resetForTesting();
  });
  const start = () => service.startImpersonation({ context, tenantId, propertyId, reason: 'Atomic support test' });
  const endContext = (id) => impersonationContext({ tenantId, propertyId, platformUserId: user.id, impersonationSessionId: id });

  it('rolls back both a new grant and its audit when audit writing fails', async () => {
    mockFailEvent = 'impersonation_started';
    await expect(start()).rejects.toThrow('Injected audit failure');
    expect(await db()('impersonation_sessions').where({ tenant_id: tenantId })).toHaveLength(0);
    expect(await db()('auth_events').where({ platform_user_id: user.id })).toHaveLength(0);
  });

  it('rolls back termination and its audit together, then commits both on retry', async () => {
    const grant = await start();
    mockFailEvent = 'impersonation_ended';
    await expect(service.endImpersonation({ context: endContext(grant.impersonationSessionId) })).rejects.toThrow('Injected audit failure');
    expect((await db()('impersonation_sessions').where({ id: grant.impersonationSessionId }).first()).ended_at).toBeNull();
    expect(await db()('auth_events').where({ platform_user_id: user.id, event_type: 'impersonation_ended' })).toHaveLength(0);
    mockFailEvent = null;
    const results = await Promise.all([service.endImpersonation({ context: endContext(grant.impersonationSessionId) }), service.endImpersonation({ context: endContext(grant.impersonationSessionId) })]);
    expect(results.map((r) => r.ended).sort()).toEqual([false, true]);
    expect((await db()('impersonation_sessions').where({ id: grant.impersonationSessionId }).first()).ended_at).not.toBeNull();
    expect(await db()('auth_events').where({ platform_user_id: user.id, event_type: 'impersonation_ended' })).toHaveLength(1);
  });
});
