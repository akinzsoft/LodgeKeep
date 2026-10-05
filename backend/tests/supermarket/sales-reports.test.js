'use strict';

/**
 * Supermarket sales reports: a business-date range on "All sales", and a total (with the count and the voided
 * count) on both "All sales" and the cashier's "Today's sales". Supermarket-only; the hotel reports are untouched.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem } = require('../helpers/catalogue');

describe('supermarket sales reports', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let martId;
  let barId;
  let itemId;
  const users = {};
  let counter = 0;
  const TODAY = '2027-12-10';
  const YESTERDAY = '2027-12-09';

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const scope = () => ({ tenant_id: ctx.a.id, property_id: propertyId });
  const tokenFor = (userId, tenant = ctx.a) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const as = (userId, tenant) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`).set('Idempotency-Key', `sr-${next()}`),
  });

  async function userWithRole(role) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'User', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    return id;
  }
  async function outlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ ...scope(), code: `R${next()}`.slice(0, 30), name, type });
    return id;
  }
  /** One cash sale of `quantity` of the product (price 10.00, no VAT row so total = subtotal). */
  async function sell(userId, quantity = 1) {
    const res = await as(userId).post('/api/v1/supermarket/sales').send({ outlet_id: martId, method: 'cash', items: [{ menu_item_id: itemId, quantity }] });
    expect(res.status).toBe(201);
    return res.body.data;
  }
  /** Moves a sale to another business date (its settlement's), as a sale settled on an earlier day would be. */
  const moveToBusinessDate = (sale, date) => t.trx('pos_order_settlements').where({ id: sale.settlement_id }).update({ business_date: date });
  const totals = (userId, query = '') => as(userId).get(`/api/v1/supermarket/sales/totals?outlet_id=${martId}${query}`);
  const myTotals = (userId) => as(userId).get(`/api/v1/supermarket/my-sales/totals?outlet_id=${martId}`);
  const list = (userId, query = '') => as(userId).get(`/api/v1/supermarket/sales?outlet_id=${martId}${query}`);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: TODAY });
    martId = await outlet('supermarket', 'Reports Mart');
    barId = await outlet('bar', 'Reports Bar');
    for (const role of ['manager', 'pos_operator']) users[role] = await userWithRole(role);
    users.other = await userWithRole('pos_operator');
    [itemId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: martId, name: `Report item ${next()}`, category: 'Reports Mart Cat', price: '10.00' });
  });

  describe('totals', () => {
    it("default to the business date and add up exactly the sales in view; a void leaves the total and is counted apart", async () => {
      const a = await sell(users.pos_operator, 1); // 10.00
      await sell(users.pos_operator, 3); // 30.00
      const c = await sell(users.manager, 2); // 20.00
      let res = await totals(users.manager);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ from: TODAY, to: TODAY, saleCount: 3, voidedCount: 0, total: '60.00', subtotal: '60.00', tax: '0.00', voidedTotal: '0.00' });

      const voided = await as(users.manager).post(`/api/v1/supermarket/sales/${c.id}/void`).send({ reason: 'test' });
      expect(voided.status).toBe(200);
      res = await totals(users.manager);
      expect(res.body.data).toMatchObject({ saleCount: 2, voidedCount: 1, total: '40.00', voidedTotal: '20.00' });
      expect(a.id).toBeTruthy();
    });

    it('use the BUSINESS date: a sale settled yesterday is not today, even though it was created today', async () => {
      const early = await sell(users.manager, 5); // 50.00, created now
      await moveToBusinessDate(early, YESTERDAY);
      expect((await totals(users.manager)).body.data.total).toBe('40.00'); // today unchanged
      const yesterday = await totals(users.manager, `&from=${YESTERDAY}&to=${YESTERDAY}`);
      expect(yesterday.body.data).toMatchObject({ saleCount: 1, total: '50.00' });
      const both = await totals(users.manager, `&from=${YESTERDAY}&to=${TODAY}`);
      expect(both.body.data).toMatchObject({ saleCount: 3, voidedCount: 1, total: '90.00' });
      // One end alone is a single day.
      expect((await totals(users.manager, `&from=${YESTERDAY}`)).body.data).toMatchObject({ from: YESTERDAY, to: YESTERDAY, total: '50.00' });
      expect((await totals(users.manager, `&to=${TODAY}`)).body.data).toMatchObject({ from: TODAY, to: TODAY, total: '40.00' });
    });

    it("the list for a range matches: the same sales by business date, newest first", async () => {
      const res = await list(users.manager, `&from=${YESTERDAY}&to=${YESTERDAY}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].total).toBe('50.00');
      const both = await list(users.manager, `&from=${YESTERDAY}&to=${TODAY}`);
      expect(both.body.data).toHaveLength(4); // 3 kept + 1 voided, all shown
    });

    it('validate the range: real dates, from not after to, at most a year', async () => {
      for (const q of ['&from=2027-13-40', '&from=hello', `&from=${TODAY}&to=${YESTERDAY}`, '&from=2026-01-01&to=2027-12-10']) {
        expect((await totals(users.manager, q)).status).toBe(400);
        expect((await list(users.manager, q)).status).toBe(400);
      }
      expect((await totals(users.manager, '&from=2027-01-01&to=2027-12-10')).status).toBe(200);
    });

    it('stay exact over more than the list cap (100 shown): the total counts all 205, the list shows the latest 100', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-12-20' });
      const rows = [];
      for (let i = 0; i < 205; i += 1) rows.push(await sell(users.pos_operator, 1));
      const res = await totals(users.manager);
      expect(res.body.data).toMatchObject({ from: '2027-12-20', saleCount: 205, voidedCount: 0, total: '2050.00' });
      const listed = await list(users.manager, '&from=2027-12-20&to=2027-12-20');
      expect(listed.body.data.length).toBe(100); // capped: the screen says "latest 100 of 205"
      expect(rows).toHaveLength(205);
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: TODAY });
    });
  });

  describe('the total split by how it was paid', () => {
    const DAY = '2028-01-05';
    /** Re-labels a cash sale as another tender: a card-machine sale, or an online (Paystack) sale by its channel. */
    async function payAs(sale, method, channel) {
      await t.trx('supermarket_sales').where({ id: sale.id }).update({ method });
      if (!channel) return;
      const [paymentId] = await t.trx('payments').insert({
        ...scope(),
        idempotency_key: `idem-${next()}`,
        provider: 'paystack',
        provider_reference: `ref-${next()}`,
        amount: sale.total,
        currency: 'NGN',
        status: 'CAPTURED',
        settlement_target: 'supermarket_sale',
        pos_order_id: sale.pos_order_id,
        provider_channel: channel,
      });
      await t.trx('pos_order_settlements').where({ id: sale.settlement_id }).update({ payment_id: paymentId });
    }
    const byMethod = (res) => Object.fromEntries(res.body.data.byMethod.map((row) => [row.method, row]));

    beforeAll(async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DAY });
    });
    afterAll(async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: TODAY });
    });

    it('splits the total into cash, card machine, online card, online transfer and other online, voided excluded; the parts add up to the total', async () => {
      await sell(users.pos_operator, 1); // 10 cash
      await sell(users.pos_operator, 1); // 10 cash
      await payAs(await sell(users.pos_operator, 2), 'terminal'); // 20 card machine
      await payAs(await sell(users.pos_operator, 3), 'card', 'card'); // 30 online card
      await payAs(await sell(users.manager, 4), 'card', 'bank_transfer'); // 40 transfer
      await payAs(await sell(users.manager, 5), 'card', 'ussd'); // 50 other online
      const voided = await sell(users.manager, 6); // 60 cash, then voided
      await as(users.manager).post(`/api/v1/supermarket/sales/${voided.id}/void`).send({ reason: 'test' });

      const res = await totals(users.manager);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ saleCount: 6, voidedCount: 1, total: '160.00' });
      const split = byMethod(res);
      expect(split.cash).toMatchObject({ saleCount: 2, total: '20.00' });
      expect(split.terminal).toMatchObject({ saleCount: 1, total: '20.00' });
      expect(split.online_card).toMatchObject({ saleCount: 1, total: '30.00' });
      expect(split.online_transfer).toMatchObject({ saleCount: 1, total: '40.00' });
      expect(split.online_other).toMatchObject({ saleCount: 1, total: '50.00' });
      expect(res.body.data.byMethod.map((row) => row.method)).toEqual(['cash', 'terminal', 'online_card', 'online_transfer', 'online_other']);
      const sum = res.body.data.byMethod.reduce((acc, row) => acc + Math.round(Number(row.total) * 100), 0);
      expect(sum).toBe(16000); // exactly the grand total (10 + 10 + 20 + 30 + 40 + 50)
    });

    it("the cashier's own total is split the same way, over only their sales", async () => {
      const res = await myTotals(users.pos_operator);
      const split = byMethod(res);
      expect(res.body.data).toMatchObject({ saleCount: 4, total: '70.00' }); // 10 + 10 + 20 + 30
      expect(split.cash).toMatchObject({ saleCount: 2, total: '20.00' });
      expect(split.terminal).toMatchObject({ total: '20.00' });
      expect(split.online_card).toMatchObject({ total: '30.00' });
      expect(split.online_transfer).toBeUndefined(); // the manager's sale, not theirs
      expect(split.online_other).toBeUndefined();
    });

    it('always lists cash (the drawer) even with no cash sales, and omits the other methods that were not used', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2028-01-06' });
      await payAs(await sell(users.manager, 1), 'terminal');
      const res = await totals(users.manager);
      expect(res.body.data.byMethod).toEqual([
        { method: 'cash', saleCount: 0, total: '0.00' },
        { method: 'terminal', saleCount: 1, total: '10.00' },
      ]);
    });
  });

  describe('/supermarket/report keeps its open-ended range', () => {
    it('a lone from means "from then on" and a lone to means "up to then" (not a single day)', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2028-02-01' });
      const early = await sell(users.manager, 1); // 2028-02-01
      const late = await sell(users.manager, 2);
      await moveToBusinessDate(late, '2028-02-10');
      const report = (q) => as(users.manager).get(`/api/v1/supermarket/report?outlet_id=${martId}${q}`);
      expect((await report('&from=2028-02-05')).body.data.saleCount).toBe(1); // only the later sale, though it is not on the 5th itself
      expect((await report('&to=2028-02-05')).body.data.saleCount).toBeGreaterThanOrEqual(1);
      expect((await report('&to=2028-02-05')).body.data.total).not.toBe((await report('')).body.data.total); // the later sale is left out
      expect((await report('&from=2028-02-01&to=2028-02-10')).body.data.saleCount).toBe(2);
      expect(early.id).toBeTruthy();
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: TODAY });
    });
  });

  describe("the cashier's own Today's sales total", () => {
    it('adds up only their own sales on the business date, with their voided count', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-12-30' });
      await sell(users.pos_operator, 1); // 10
      const mine2 = await sell(users.pos_operator, 2); // 20
      await sell(users.other, 7); // 70, someone else's
      await as(users.manager).post(`/api/v1/supermarket/sales/${mine2.id}/void`).send({ reason: 'test' });
      const res = await myTotals(users.pos_operator);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ from: '2027-12-30', to: '2027-12-30', saleCount: 1, voidedCount: 1, total: '10.00', voidedTotal: '20.00' });
      expect((await myTotals(users.other)).body.data).toMatchObject({ saleCount: 1, total: '70.00' });
      // The manager's All sales sees everyone's.
      expect((await totals(users.manager)).body.data).toMatchObject({ saleCount: 2, total: '80.00' });
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: TODAY });
    });
  });

  describe('access and isolation', () => {
    it('the All sales totals need supermarket.report; a cashier gets 403 there but can read their own', async () => {
      expect((await totals(users.pos_operator)).status).toBe(403);
      expect((await list(users.pos_operator)).status).toBe(403);
      expect((await myTotals(users.pos_operator)).status).toBe(200);
      expect((await myTotals(users.manager)).status).toBe(200);
    });

    it('need a supermarket outlet the caller covers', async () => {
      expect((await as(users.manager).get('/api/v1/supermarket/sales/totals')).status).toBe(400);
      expect((await as(users.manager).get(`/api/v1/supermarket/sales/totals?outlet_id=${barId}`)).status).toBe(422);
      await t.trx('user_outlet_assignments').insert({ ...scope(), user_id: users.other, outlet_id: barId });
      expect((await myTotals(users.other)).status).toBe(400); // assigned elsewhere
      await t.trx('user_outlet_assignments').where({ user_id: users.other }).delete();
    });

    it("never include another tenant's sales or outlets", async () => {
      const res = await as(ctx.b.users[0].id, ctx.b).get(`/api/v1/supermarket/sales/totals?outlet_id=${martId}`);
      expect([400, 403, 404, 422]).toContain(res.status);
    });
  });
});
