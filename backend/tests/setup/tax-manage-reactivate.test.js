'use strict';

/**
 * `tax.manage` (super_admin only) gates create-version, Reactivate, Deactivate and Delete; admin and manager
 * keep read access. Reactivate never backfills a gap, and the hotel and supermarket rows resolve independently.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Setup → Taxes: tax.manage, create-version gap and Reactivate', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[0].id }).update({ role: 'super_admin' });
  });

  const tokenFor = (user) => signAccessToken({ aud: 'staff', sub: String(user.id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  const superAdmin = () => tokenFor(ctx.a.users[1]);
  const manager = () => tokenFor(ctx.a.users[0]); // manager at properties[0]
  const asRole = async (role) => {
    await t.trx('user_property_access').where({ user_id: ctx.a.users[0].id, property_id: ctx.a.properties[0].id }).update({ role });
    return tokenFor(ctx.a.users[0]);
  };

  const post = (path, token, body) => t.request.post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
  const resolve = (code, date) =>
    t.request.get('/api/v1/taxes/resolve').query({ tax_code: code, business_date: date }).set('Authorization', `Bearer ${superAdmin()}`);
  const versions = (code) => t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: code }).orderBy('effective_from');
  const body = (code, extra = {}) => ({
    tax_code: code, name: code, rate: '5.0000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'percentage', ...extra,
  });

  beforeEach(async () => {
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2026-10-10' });
    await t.trx('user_property_access').where({ user_id: ctx.a.users[0].id, property_id: ctx.a.properties[0].id }).update({ role: 'manager' });
  });

  describe('permission', () => {
    it.each(['admin', 'manager'])('%s gets 403 on all four tax actions and still reads the list', async (role) => {
      const token = await asRole(role);
      await post('/taxes', superAdmin(), body('PERM1'));
      expect((await post('/taxes', token, body('PERM2'))).status).toBe(403);
      expect((await post('/taxes/PERM1/deactivate', token, { reason: 'x' })).status).toBe(403);
      expect((await post('/taxes/PERM1/reactivate', token, { reason: 'x' })).status).toBe(403);
      expect((await post('/taxes/PERM1/delete', token, { reason: 'x' })).status).toBe(403);
      expect((await t.request.get('/api/v1/taxes').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      expect(await versions('PERM2')).toHaveLength(0);
      expect(await versions('PERM1')).toHaveLength(1);
    });

    it('is not granted by setup.manage alone: the key is held by super_admin only', async () => {
      const key = await t.trx('permissions').where({ permission_key: 'tax.manage' }).first('id');
      const holders = await t.trx('role_permissions').join('roles', 'roles.id', 'role_permissions.role_id').where({ permission_id: key.id, 'roles.tenant_id': ctx.a.id }).pluck('roles.code');
      expect(holders).toEqual(['super_admin']);
    });
  });

  describe('create version never backfills a gap', () => {
    it('leaves a deactivated version closed; days in the gap stay untaxed', async () => {
      await post('/taxes', superAdmin(), body('GAP1'));
      expect((await post('/taxes/GAP1/deactivate', superAdmin(), { reason: 'off', deactivate_from: '2026-10-10' })).status).toBe(200);
      expect((await post('/taxes', superAdmin(), body('GAP1', { rate: '9.0000', effective_from: '2026-10-20' }))).status).toBe(201);
      const rows = await versions('GAP1');
      expect(rows[0].effective_to).toBe('2026-10-09');
      expect((await resolve('GAP1', '2026-10-15')).body.data).toBeNull();
      expect((await resolve('GAP1', '2026-10-20')).body.data.rate).toBe('9.0000');
    });

    it('still closes an open previous version the day before', async () => {
      await post('/taxes', superAdmin(), body('GAP2'));
      await post('/taxes', superAdmin(), body('GAP2', { rate: '8.0000', effective_from: '2026-06-01' }));
      expect((await versions('GAP2'))[0].effective_to).toBe('2026-05-31');
    });
  });

  describe('reactivate', () => {
    it('adds a version copying rate/settings/applies_to from the business date, without touching the old one, and audits it', async () => {
      await post('/taxes', superAdmin(), body('RE1', { rate: '7.5000', is_inclusive: true, applies_to: 'supermarket_sale' }));
      await post('/taxes/RE1/deactivate', superAdmin(), { reason: 'off', deactivate_from: '2026-10-10' });
      const res = await post('/taxes/RE1/reactivate', superAdmin(), { reason: 'back', reactivate_from: '2026-10-15' });
      expect(res.status).toBe(201);
      const rows = await versions('RE1');
      expect(rows).toHaveLength(2);
      expect(rows[0].effective_to).toBe('2026-10-09');
      expect(rows[1]).toMatchObject({ rate: '7.5000', applies_to: 'supermarket_sale' });
      expect(rows[1].is_inclusive).toBeTruthy();
      expect(rows[1].effective_to).toBeNull();
      expect((await resolve('RE1', '2026-10-13')).body.data).toBeNull(); // gap not backfilled
      expect((await resolve('RE1', '2026-10-15')).body.data.rate).toBe('7.5000');
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'taxes', action: 'reactivate' }).first();
      expect(audit.reason).toBe('back');
    });

    it('defaults to the business date', async () => {
      await post('/taxes', superAdmin(), body('RE2'));
      await post('/taxes/RE2/deactivate', superAdmin(), { reason: 'off', deactivate_from: '2026-10-10' });
      await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2026-10-20' });
      const res = await post('/taxes/RE2/reactivate', superAdmin(), { reason: 'back' });
      expect(res.status).toBe(201);
      expect(res.body.data.effective_from).toBe('2026-10-20');
    });

    it('refuses a past date (by business date, not calendar date)', async () => {
      await post('/taxes', superAdmin(), body('RE3'));
      await post('/taxes/RE3/deactivate', superAdmin(), { reason: 'off', deactivate_from: '2026-10-10' });
      const res = await post('/taxes/RE3/reactivate', superAdmin(), { reason: 'back', reactivate_from: '2026-10-09' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_TAX_REACTIVATION_IN_PAST');
      expect(await versions('RE3')).toHaveLength(1);
    });

    it('refuses when the tax has a live version (open, or closing on a future date)', async () => {
      await post('/taxes', superAdmin(), body('RE4'));
      let res = await post('/taxes/RE4/reactivate', superAdmin(), { reason: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_TAX_ALREADY_ACTIVE');
      await post('/taxes/RE4/deactivate', superAdmin(), { reason: 'later', deactivate_from: '2026-10-25' });
      res = await post('/taxes/RE4/reactivate', superAdmin(), { reason: 'x', reactivate_from: '2026-10-30' });
      expect(res.status).toBe(409);
      expect(await versions('RE4')).toHaveLength(1);
    });

    it('404 for an unknown code', async () => {
      expect((await post('/taxes/NOPE/reactivate', superAdmin(), { reason: 'x' })).status).toBe(404);
    });

    it('hotel and supermarket rows reactivate and resolve independently by code and applies_to', async () => {
      await post('/taxes', superAdmin(), body('HOTELV', { rate: '7.5000', applies_to: 'all' }));
      await post('/taxes', superAdmin(), body('SUPERV', { rate: '1.5000', applies_to: 'supermarket_sale' }));
      await post('/taxes/HOTELV/deactivate', superAdmin(), { reason: 'off', deactivate_from: '2026-10-10' });
      await post('/taxes/SUPERV/deactivate', superAdmin(), { reason: 'off', deactivate_from: '2026-10-10' });
      expect((await post('/taxes/HOTELV/reactivate', superAdmin(), { reason: 'on', reactivate_from: '2026-10-14' })).status).toBe(201);
      expect((await resolve('HOTELV', '2026-10-14')).body.data).toMatchObject({ rate: '7.5000', applies_to: 'all' });
      expect((await resolve('SUPERV', '2026-10-14')).body.data).toBeNull(); // supermarket still off
      expect((await post('/taxes/SUPERV/reactivate', superAdmin(), { reason: 'on', reactivate_from: '2026-10-16' })).status).toBe(201);
      expect((await resolve('SUPERV', '2026-10-16')).body.data).toMatchObject({ rate: '1.5000', applies_to: 'supermarket_sale' });
      expect((await resolve('HOTELV', '2026-10-16')).body.data.rate).toBe('7.5000');
      expect((await versions('HOTELV')).every((v) => v.applies_to === 'all')).toBe(true);
    });
  });
});
