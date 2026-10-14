'use strict';

/**
 * Deleting and deactivating a tax. Nothing stores a tax id, so "in use" is
 * inferred from records dated inside a version's window that carry tax
 * (folio tax lines by "(CODE)", POS settlements and supermarket sales by
 * tax_amount). The rule is conservative: it may over-refuse, never under-count.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Setup → Taxes: deactivate and delete', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    // users[1] holds housekeeping at properties[0] in the fixture; make them a super_admin (tax.manage) in both tenants.
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('user_property_access').where({ user_id: tenant.users[1].id, property_id: tenant.properties[0].id }).update({ role: 'super_admin' });
    }
  });

  const superAdmin = () =>
    signAccessToken({ aud: 'staff', sub: String(ctx.a.users[1].id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  const manager = () =>
    signAccessToken({ aud: 'staff', sub: String(ctx.a.users[0].id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  const otherTenant = () =>
    signAccessToken({ aud: 'staff', sub: String(ctx.b.users[1].id), tenant_id: String(ctx.b.id), property_id: String(ctx.b.properties[0].id) });

  const post = (path, token, body) => t.request.post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  async function addTax(code, extra = {}) {
    const res = await post('/taxes', superAdmin(), {
      tax_code: code, name: code, rate: '5.0000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'percentage', ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.data;
  }
  const rowsFor = (tenant, code) => t.trx('taxes').where({ tenant_id: tenant.id, tax_code: code });
  const resolve = (code, date) =>
    t.request.get('/api/v1/taxes/resolve').query({ tax_code: code, business_date: date }).set('Authorization', `Bearer ${superAdmin()}`);

  beforeEach(async () => {
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2026-10-10' });
  });

  describe('deactivate', () => {
    it('defaults to the business date: stops applying from that day, history untouched', async () => {
      await addTax('DEACT1');
      const res = await post('/taxes/DEACT1/deactivate', superAdmin(), { reason: 'No longer charged' });
      expect(res.status).toBe(200);
      expect(res.body.data.effective_to).toBe('2026-10-09');
      expect((await resolve('DEACT1', '2026-06-01')).body.data.rate).toBe('5.0000');
      expect((await resolve('DEACT1', '2026-10-10')).body.data).toBeNull();
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'taxes', action: 'deactivate' }).first();
      expect(audit.reason).toBe('No longer charged');
      expect(audit.actor_user_id ?? audit.user_id).toBeDefined();
    });

    it('accepts a future date and keeps applying until then', async () => {
      await addTax('DEACT2');
      const res = await post('/taxes/DEACT2/deactivate', superAdmin(), { reason: 'Ends in Dec', deactivate_from: '2026-12-01' });
      expect(res.status).toBe(200);
      expect((await resolve('DEACT2', '2026-11-30')).body.data.rate).toBe('5.0000');
      expect((await resolve('DEACT2', '2026-12-01')).body.data).toBeNull();
    });

    it('refuses a past date, a date not after the start, and an already-inactive tax', async () => {
      await addTax('DEACT3');
      const past = await post('/taxes/DEACT3/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-09' });
      expect(past.status).toBe(422);
      expect(past.body.error.code).toBe('BUSINESS_RULE_TAX_DEACTIVATION_IN_PAST');
      await addTax('DEACT3B', { effective_from: '2026-11-01' });
      const early = await post('/taxes/DEACT3B/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-11-01' });
      expect(early.body.error.code).toBe('BUSINESS_RULE_TAX_DEACTIVATION_BEFORE_START');
      await post('/taxes/DEACT3/deactivate', superAdmin(), { reason: 'x' });
      const again = await post('/taxes/DEACT3/deactivate', superAdmin(), { reason: 'x' });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT_TAX_ALREADY_INACTIVE');
    });

    it('requires a reason, setup.manage, and never reaches another tenant', async () => {
      await addTax('DEACT4');
      expect((await post('/taxes/DEACT4/deactivate', superAdmin(), {})).status).toBe(400);
      expect((await post('/taxes/DEACT4/deactivate', superAdmin(), { reason: '   ' })).status).toBe(400);
      expect((await post('/taxes/DEACT4/deactivate', manager(), { reason: 'x' })).status).toBe(403);
      expect((await post('/taxes/DEACT4/deactivate', otherTenant(), { reason: 'x' })).status).toBe(404);
      expect((await rowsFor(ctx.a, 'DEACT4'))[0].effective_to).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes every version of a never-used tax and audits who and why', async () => {
      await addTax('DEL1');
      await addTax('DEL1', { rate: '6.0000', effective_from: '2026-05-01' });
      const res = await post('/taxes/DEL1/delete', superAdmin(), { reason: 'Created by mistake' });
      expect(res.status).toBe(200);
      expect(res.body.data.deleted_versions).toBe(2);
      expect(await rowsFor(ctx.a, 'DEL1')).toHaveLength(0);
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'taxes', action: 'delete_tax' }).first();
      expect(audit.reason).toBe('Created by mistake');
    });

    it('refuses when a folio tax line in a version window names the code, with counts, and deletes nothing', async () => {
      await addTax('DEL2');
      await t.trx('folio_line_items').insert({
        tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, folio_id: ctx.a.folios[0].id,
        type: 'tax', description: 'DEL2 (DEL2)', amount: '1.00', currency: 'NGN', business_date: '2026-06-01', voided_at: null,
      });
      const res = await post('/taxes/DEL2/delete', superAdmin(), { reason: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_TAX_IN_USE');
      expect(res.body.error.details.usage).toEqual({ folioTaxLines: 1, posSettlements: 0, supermarketSales: 0 });
      expect(res.body.error.message).toMatch(/Deactivate it instead/);
      expect(await rowsFor(ctx.a, 'DEL2')).toHaveLength(1);
    });

    it('refuses on a POS settlement with tax inside the window, but not outside it', async () => {
      await addTax('DEL3', { effective_from: '2026-03-01' });
      const base = { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, pos_order_id: ctx.a.posOrders[0].id, method: 'cash', subtotal: '10.00', currency: 'NGN', settled_by_user_id: ctx.a.users[0].id, tax_amount: '0.75', business_date: '2026-01-15' };
      await t.trx('pos_order_settlements').insert({ ...base, settled_at: '2026-01-15 10:00:00' });
      expect((await post('/taxes/DEL3/delete', superAdmin(), { reason: 'x' })).status).toBe(200); // before the window: not counted
      await addTax('DEL3B', { effective_from: '2026-01-01' });
      const res = await post('/taxes/DEL3B/delete', superAdmin(), { reason: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.usage.posSettlements).toBeGreaterThanOrEqual(1);
    });

    it('records dated after a closed tax window do not count against it', async () => {
      await addTax('DEL3C', { effective_from: '2026-10-11' });
      await post('/taxes/DEL3C/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-20' });
      await t.trx('pos_order_settlements').insert({
        tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, pos_order_id: ctx.a.posOrders[0].id, method: 'cash', subtotal: '10.00',
        currency: 'NGN', settled_by_user_id: ctx.a.users[0].id, tax_amount: '0.75', business_date: '2026-10-25', settled_at: '2026-10-25 10:00:00',
      });
      expect((await post('/taxes/DEL3C/delete', superAdmin(), { reason: 'x' })).status).toBe(200);
    });

    it('a supermarket-only tax is judged by supermarket sales', async () => {
      await addTax('SMT', { applies_to: 'supermarket_sale', effective_from: '2020-01-01' });
      await t.trx('supermarket_sales').where({ id: ctx.a.supermarketSales[0].id }).update({ tax_amount: '1.50' });
      const res = await post('/taxes/SMT/delete', superAdmin(), { reason: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.usage.supermarketSales).toBe(1);
    });

    it('a tax code with _ does not match another code through LIKE wildcards', async () => {
      await addTax('A_B', { effective_from: '2030-01-01' });
      await t.trx('folio_line_items').insert({
        tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, folio_id: ctx.a.folios[0].id,
        type: 'tax', description: 'Other (AXB)', amount: '1.00', currency: 'NGN', business_date: '2030-06-01',
      });
      expect((await post('/taxes/A_B/delete', superAdmin(), { reason: 'x' })).status).toBe(200);
    });

    it('requires a reason and setup.manage, and is 404 for another tenant or an unknown code', async () => {
      await addTax('DEL4');
      expect((await post('/taxes/DEL4/delete', superAdmin(), {})).status).toBe(400);
      expect((await post('/taxes/DEL4/delete', manager(), { reason: 'x' })).status).toBe(403);
      expect((await post('/taxes/DEL4/delete', otherTenant(), { reason: 'x' })).status).toBe(404);
      expect((await post('/taxes/NOPE/delete', superAdmin(), { reason: 'x' })).status).toBe(404);
      expect(await rowsFor(ctx.a, 'DEL4')).toHaveLength(1);
    });
  });

  describe('isolation: other taxes resolve exactly as before', () => {
    it('deactivating or deleting one tax changes nothing for VAT, the other tenant, or the engine', async () => {
      const dates = ['2026-01-01', '2026-06-01', '2026-10-10', '2027-01-01'];
      const before = await Promise.all(dates.map(async (d) => (await resolve('VAT', d)).body.data));
      const bTaxesBefore = await t.trx('taxes').where({ tenant_id: ctx.b.id });
      await addTax('ISO1');
      await post('/taxes/ISO1/deactivate', superAdmin(), { reason: 'x' });
      await addTax('ISO2');
      await post('/taxes/ISO2/delete', superAdmin(), { reason: 'x' });
      const after = await Promise.all(dates.map(async (d) => (await resolve('VAT', d)).body.data));
      expect(after).toEqual(before);
      expect(await t.trx('taxes').where({ tenant_id: ctx.b.id })).toEqual(bTaxesBefore);
    });
  });
});
