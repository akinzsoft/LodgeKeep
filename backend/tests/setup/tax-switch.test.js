'use strict';

/**
 * The per-tax On/Off switch. `tax.manage` (super_admin only) gates it; Off means the tax is not charged on any new
 * bill from the next read, On means it is. Hotel and supermarket rows are independent. Past records are never touched.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../../src/modules/cashiering/tax-engine');

describe('Setup → Taxes: On/Off switch', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('user_property_access').where({ user_id: tenant.users[1].id, property_id: tenant.properties[0].id }).update({ role: 'super_admin' });
    }
  });

  const token = (tenant, user) => signAccessToken({ aud: 'staff', sub: String(user.id), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const superAdmin = () => token(ctx.a, ctx.a.users[1]);
  const otherTenant = () => token(ctx.b, ctx.b.users[1]);
  const asRole = async (role) => {
    await t.trx('user_property_access').where({ user_id: ctx.a.users[0].id, property_id: ctx.a.properties[0].id }).update({ role });
    return token(ctx.a, ctx.a.users[0]);
  };
  const post = (path, tok, body) => t.request.post(`/api/v1${path}`).set('Authorization', `Bearer ${tok}`).send(body);
  const rows = (code) => t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: code }).orderBy('effective_from');
  const addTax = async (code, extra = {}) => {
    const res = await post('/taxes', superAdmin(), { tax_code: code, name: code, rate: '10.0000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'percentage', ...extra });
    expect(res.status).toBe(201);
  };
  const taxOn = async (chargeType, date = '2026-10-10') => {
    const allTaxRows = await t.trx('taxes').where({ tenant_id: ctx.a.id });
    const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate: date, chargeType });
    return computeChargeWithTax({ baseAmount: '100.00', taxVersions }).taxLines.map((l) => l.taxCode);
  };
  const audits = async (code, action) => t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'taxes', action, entity_id: String((await rows(code)).at(-1).id) });

  beforeEach(async () => {
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2026-10-10' });
    await t.trx('user_property_access').where({ user_id: ctx.a.users[0].id, property_id: ctx.a.properties[0].id }).update({ role: 'manager' });
  });

  it('Off: the tax is not charged on the next bill; On: it is charged again; no dates involved', async () => {
    await addTax('SW1');
    expect(await taxOn('room_charge')).toContain('SW1');
    const off = await post('/taxes/SW1/set-enabled', superAdmin(), { enabled: false });
    expect(off.status).toBe(200);
    expect(await taxOn('room_charge')).not.toContain('SW1');
    expect(await taxOn('room_charge', '2026-03-01')).not.toContain('SW1'); // every version carries the same state
    expect((await post('/taxes/SW1/set-enabled', superAdmin(), { enabled: true })).status).toBe(200);
    expect(await taxOn('room_charge')).toContain('SW1');
    expect(await rows('SW1')).toHaveLength(1); // a live tax is just flipped, no new version
  });

  it('hotel and supermarket taxes switch independently', async () => {
    await addTax('SWHOT', { applies_to: 'all', rate: '7.5000' });
    await addTax('SWSUP', { applies_to: 'supermarket_sale', rate: '1.5000' });
    expect(await taxOn('pos_charge')).toContain('SWHOT');
    expect(await taxOn('supermarket_sale')).toEqual(['SWSUP']);
    await post('/taxes/SWSUP/set-enabled', superAdmin(), { enabled: false });
    expect(await taxOn('supermarket_sale')).toEqual([]);
    expect(await taxOn('pos_charge')).toContain('SWHOT');
    await post('/taxes/SWSUP/set-enabled', superAdmin(), { enabled: true });
    await post('/taxes/SWHOT/set-enabled', superAdmin(), { enabled: false });
    expect(await taxOn('pos_charge')).not.toContain('SWHOT');
    expect(await taxOn('supermarket_sale')).toEqual(['SWSUP']);
  });

  it('a new rate version inherits the switch instead of turning the tax back on', async () => {
    await addTax('SW2');
    await post('/taxes/SW2/set-enabled', superAdmin(), { enabled: false });
    await addTax('SW2', { rate: '12.0000', effective_from: '2026-11-01' });
    expect((await rows('SW2')).map((r) => Boolean(r.enabled))).toEqual([false, false]);
    expect(await taxOn('room_charge', '2026-11-05')).not.toContain('SW2');
    await post('/taxes/SW2/set-enabled', superAdmin(), { enabled: true });
    expect((await rows('SW2')).map((r) => Boolean(r.enabled))).toEqual([true, true]);
  });

  it('switching On a tax that ended under the old date system adds a version from the business date; the gap stays untaxed', async () => {
    await addTax('SW3');
    await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'SW3' }).update({ effective_to: '2026-10-05', enabled: 0 });
    expect(await taxOn('room_charge', '2026-10-08')).not.toContain('SW3');
    expect((await post('/taxes/SW3/set-enabled', superAdmin(), { enabled: true })).status).toBe(200);
    const all = await rows('SW3');
    expect(all).toHaveLength(2);
    expect(all[0].effective_to).toBe('2026-10-05');
    expect(all[1]).toMatchObject({ rate: '10.0000', effective_from: '2026-10-10', effective_to: null });
    expect(all.every((r) => Boolean(r.enabled))).toBe(true);
    expect(await taxOn('room_charge', '2026-10-08')).not.toContain('SW3');
    expect(await taxOn('room_charge', '2026-10-10')).toContain('SW3');
  });

  it('a tax whose end date has passed counts as Off: On restarts it, Off is a no-op', async () => {
    await addTax('SW4');
    await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'SW4' }).update({ effective_to: '2026-10-05' });
    const off = await post('/taxes/SW4/set-enabled', superAdmin(), { enabled: false });
    expect(off.body.data.changed).toBe(false);
    expect((await post('/taxes/SW4/set-enabled', superAdmin(), { enabled: true })).body.data.changed).toBe(true);
    expect(await taxOn('room_charge')).toContain('SW4');
  });

  it('a tax scheduled to end can be switched Off and On without losing its end date', async () => {
    await addTax('SW5');
    await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'SW5' }).update({ effective_to: '2026-12-31' });
    await post('/taxes/SW5/set-enabled', superAdmin(), { enabled: false });
    await post('/taxes/SW5/set-enabled', superAdmin(), { enabled: true });
    const all = await rows('SW5');
    expect(all).toHaveLength(1);
    expect(all[0].effective_to).toBe('2026-12-31');
  });

  it('audits who and what; the note is optional; an unchanged switch writes nothing', async () => {
    await addTax('SW6');
    await post('/taxes/SW6/set-enabled', superAdmin(), { enabled: false, note: 'Exempt until July' });
    const [off] = await audits('SW6', 'switch_off');
    expect(off.reason).toBe('Exempt until July');
    expect(off.user_id).toBeTruthy();
    expect(off.before_state.enabled).toBeTruthy();
    expect(Boolean(off.after_state.enabled)).toBe(false);
    await post('/taxes/SW6/set-enabled', superAdmin(), { enabled: true });
    const [on] = await audits('SW6', 'switch_on');
    expect(on.reason).toBeNull();
    const again = await post('/taxes/SW6/set-enabled', superAdmin(), { enabled: true });
    expect(again.body.data.changed).toBe(false);
    expect(await audits('SW6', 'switch_on')).toHaveLength(1);
  });

  it('bills already made are never changed', async () => {
    await addTax('SW7');
    await t.trx('folio_line_items').insert({
      tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, folio_id: ctx.a.folios[0].id,
      type: 'tax', description: 'SW7 (SW7)', amount: '10.00', currency: 'NGN', business_date: '2026-10-09', voided_at: null,
    });
    const before = await t.trx('folio_line_items').where({ tenant_id: ctx.a.id });
    await post('/taxes/SW7/set-enabled', superAdmin(), { enabled: false });
    await post('/taxes/SW7/set-enabled', superAdmin(), { enabled: true });
    expect(await t.trx('folio_line_items').where({ tenant_id: ctx.a.id })).toEqual(before);
  });

  it('needs tax.manage; admin and manager get 403 and nothing changes; another tenant gets 404; bad body 400', async () => {
    await addTax('SW8');
    for (const role of ['admin', 'manager']) {
      expect((await post('/taxes/SW8/set-enabled', await asRole(role), { enabled: false })).status).toBe(403);
    }
    expect((await post('/taxes/SW8/set-enabled', otherTenant(), { enabled: false })).status).toBe(404);
    expect((await post('/taxes/NOPE/set-enabled', superAdmin(), { enabled: false })).status).toBe(404);
    expect((await post('/taxes/SW8/set-enabled', superAdmin(), {})).status).toBe(400);
    expect((await post('/taxes/SW8/set-enabled', superAdmin(), { enabled: 'no' })).status).toBe(400);
    expect((await rows('SW8')).every((r) => Boolean(r.enabled))).toBe(true);
  });

  it('the old date endpoints are gone', async () => {
    await addTax('SW9');
    for (const path of ['deactivate', 'reactivate', 'change-end-date']) {
      expect((await post(`/taxes/SW9/${path}`, superAdmin(), { reason: 'x' })).status).toBe(404);
    }
  });

  it('list rows carry enabled', async () => {
    await addTax('SW10');
    await post('/taxes/SW10/set-enabled', superAdmin(), { enabled: false });
    const res = await t.request.get('/api/v1/taxes').set('Authorization', `Bearer ${superAdmin()}`);
    expect(res.body.data.filter((r) => r.tax_code === 'SW10').map((r) => r.enabled)).toEqual([false]);
  });
});
