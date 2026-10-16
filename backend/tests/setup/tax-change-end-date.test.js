'use strict';

/**
 * Changing the end date of a tax that is "Scheduled to end", and the meaning of an end date.
 * An end date is the FIRST day the tax no longer applies (exclusive); the stored effective_to is the
 * day before, and the resolver taxes any date up to and including effective_to. These tests pin that
 * through the real tax engine: a bill dated the end date is untaxed, the day before is taxed.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../../src/modules/cashiering/tax-engine');

describe('Setup → Taxes: change end date', () => {
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
  const manager = () => token(ctx.a, ctx.a.users[0]);
  const otherTenant = () => token(ctx.b, ctx.b.users[1]);
  const post = (path, tok, body) => t.request.post(`/api/v1${path}`).set('Authorization', `Bearer ${tok}`).send(body);

  async function addTax(code) {
    const res = await post('/taxes', superAdmin(), {
      tax_code: code, name: code, rate: '10.0000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'percentage',
    });
    expect(res.status).toBe(201);
  }
  const version = (code) => t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: code }).first();
  const taxOnBill = async (code, date) => {
    const allTaxRows = await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: code });
    const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate: date, chargeType: 'room_charge' });
    return computeChargeWithTax({ baseAmount: '100.00', taxVersions }).taxLines;
  };

  beforeEach(async () => {
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2026-10-10' });
  });

  it('Deactivate from D: a bill dated D is untaxed, the day before is taxed', async () => {
    await addTax('END1');
    expect((await post('/taxes/END1/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-20' })).status).toBe(200);
    expect(await taxOnBill('END1', '2026-10-19')).toEqual([{ taxCode: 'END1', name: 'END1', amount: '10.00' }]);
    expect(await taxOnBill('END1', '2026-10-20')).toEqual([]);
    expect(await taxOnBill('END1', '2026-06-01')).toHaveLength(1);
  });

  it('Change end date: the new first-untaxed day is untaxed, the day before is taxed, history otherwise intact', async () => {
    await addTax('END2');
    await post('/taxes/END2/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-20' });
    const before = await version('END2');
    const res = await post('/taxes/END2/change-end-date', superAdmin(), { reason: 'Extended', end_from: '2026-11-05' });
    expect(res.status).toBe(200);
    expect(String(res.body.data.effective_to).slice(0, 10)).toBe('2026-11-04');
    expect(await taxOnBill('END2', '2026-11-04')).toHaveLength(1);
    expect(await taxOnBill('END2', '2026-11-05')).toEqual([]);
    const after = await version('END2');
    expect({ ...after, effective_to: null }).toEqual({ ...before, effective_to: null });
    expect(await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'END2' })).toHaveLength(1);
    const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'taxes', action: 'change_end_date', entity_id: String((await version('END2')).id) }).first();
    expect(audit.reason).toBe('Extended');
  });

  it('may end on the business date itself: untaxed from today, taxed yesterday', async () => {
    await addTax('END3');
    await post('/taxes/END3/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-20' });
    const res = await post('/taxes/END3/change-end-date', superAdmin(), { reason: 'Stop now', end_from: '2026-10-10' });
    expect(res.status).toBe(200);
    expect(await taxOnBill('END3', '2026-10-09')).toHaveLength(1);
    expect(await taxOnBill('END3', '2026-10-10')).toEqual([]);
  });

  it('refuses a date before the business date, a date not after the start, and an unchanged date', async () => {
    await addTax('END4');
    await post('/taxes/END4/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-20' });
    const past = await post('/taxes/END4/change-end-date', superAdmin(), { reason: 'x', end_from: '2026-10-09' });
    expect([past.status, past.body.error.code]).toEqual([422, 'BUSINESS_RULE_TAX_END_DATE_IN_PAST']);
    const same = await post('/taxes/END4/change-end-date', superAdmin(), { reason: 'x', end_from: '2026-10-20' });
    expect([same.status, same.body.error.code]).toEqual([422, 'BUSINESS_RULE_TAX_END_DATE_UNCHANGED']);
    await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'END4' }).update({ effective_from: '2026-10-12' });
    const early = await post('/taxes/END4/change-end-date', superAdmin(), { reason: 'x', end_from: '2026-10-12' });
    expect([early.status, early.body.error.code]).toEqual([422, 'BUSINESS_RULE_TAX_DEACTIVATION_BEFORE_START']);
    expect(String((await version('END4')).effective_to).slice(0, 10)).toBe('2026-10-19');
  });

  it('only works while Scheduled to end: an active, inactive or unknown tax is refused', async () => {
    await addTax('END5');
    const active = await post('/taxes/END5/change-end-date', superAdmin(), { reason: 'x', end_from: '2026-11-01' });
    expect([active.status, active.body.error.code]).toEqual([409, 'CONFLICT_TAX_NOT_SCHEDULED_TO_END']);
    await post('/taxes/END5/deactivate', superAdmin(), { reason: 'x' });
    const inactive = await post('/taxes/END5/change-end-date', superAdmin(), { reason: 'x', end_from: '2026-11-01' });
    expect([inactive.status, inactive.body.error.code]).toEqual([409, 'CONFLICT_TAX_NOT_SCHEDULED_TO_END']);
    expect((await post('/taxes/NOPE/change-end-date', superAdmin(), { reason: 'x', end_from: '2026-11-01' })).status).toBe(404);
  });

  it('needs a reason and a valid date; nothing is written on a refusal', async () => {
    await addTax('END6');
    await post('/taxes/END6/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-20' });
    const noReason = await post('/taxes/END6/change-end-date', superAdmin(), { end_from: '2026-11-01' });
    expect(noReason.status).toBe(400);
    const noDate = await post('/taxes/END6/change-end-date', superAdmin(), { reason: 'x' });
    expect([noDate.status, noDate.body.error.code]).toEqual([400, 'VALIDATION_INVALID_DATE']);
    for (const bad of ['2026-02-31', '2026-13-45']) {
      const res = await post('/taxes/END6/change-end-date', superAdmin(), { reason: 'x', end_from: bad });
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_INVALID_DATE']);
    }
    expect(String((await version('END6')).effective_to).slice(0, 10)).toBe('2026-10-19');
    const id = String((await version('END6')).id);
    expect(await t.trx('audit_log').where({ tenant_id: ctx.a.id, action: 'change_end_date', entity_id: id })).toHaveLength(0);
  });

  it('requires tax.manage; another tenant sees a 404 and nothing changes', async () => {
    await addTax('END7');
    await post('/taxes/END7/deactivate', superAdmin(), { reason: 'x', deactivate_from: '2026-10-20' });
    expect((await post('/taxes/END7/change-end-date', manager(), { reason: 'x', end_from: '2026-11-01' })).status).toBe(403);
    expect((await post('/taxes/END7/change-end-date', otherTenant(), { reason: 'x', end_from: '2026-11-01' })).status).toBe(404);
    expect(String((await version('END7')).effective_to).slice(0, 10)).toBe('2026-10-19');
  });
});
