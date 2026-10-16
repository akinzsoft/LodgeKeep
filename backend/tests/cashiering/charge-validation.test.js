'use strict';

/**
 * F-03 (product audit): `POST .../charges` checked only that `amount` was present and took `business_date` straight
 * from the body, so a front-desk user could post a NEGATIVE charge (a hidden discount that bypasses the
 * `cashiering.void_line` gate and its mandatory reason) or post into a day Night Audit had already closed.
 *
 * Rules pinned here:
 *  - a charge is a positive amount of at most 2 decimals, below a ceiling; nothing else is a charge;
 *  - a negative amount is an ADJUSTMENT: `cashiering.void_line` + a reason, audited (unchanged, now validated);
 *  - the client's `business_date` must be the property's CURRENT BUSINESS DATE (never the calendar date: between
 *    midnight and Night Audit they differ); a future date is refused for everyone;
 *  - a past date needs `cashiering.backdate`, and is refused for everyone once Night Audit has closed that day.
 * Cash and terminal payments take a business date the same way and follow the same rule.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('F-03: charge amount and business-date rules', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  const BD = '2027-03-10'; // the property's current business date
  const CLOSED = '2027-03-08'; // audited
  const OPEN_PAST = '2027-03-09'; // before the business date but never audited

  const frontDesk = () => ctx.a.users[1]; // front_desk: post_charge, NO void_line, NO backdate
  const manager = () => ctx.a.users[0]; // manager: void_line + backdate

  async function setRole(user, role) {
    const row = await t.trx('user_property_access').where({ user_id: user.id, property_id: propertyId }).first('id');
    if (row) await t.trx('user_property_access').where({ id: row.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: user.id, role });
  }
  const tokenFor = (user) => signAccessToken({ aud: 'staff', sub: String(user.id), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  let counter = 0;
  const key = () => `f03-${(counter += 1)}`;
  const post = (user, url, body) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(user)}`).set('Idempotency-Key', key()).send(body);

  let folio;
  async function openFolio() {
    counter += 1;
    const [id] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      reservation_id: ctx.a.reservations[0].id,
      folio_number: `F03${String(counter).padStart(6, '0')}`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Guest',
    });
    return t.trx('folios').where({ id }).first();
  }
  const charge = (user, body) => post(user, `/api/v1/cashiering/folios/${folio.id}/charges`, { type: 'room_charge', description: 'Room', amount: '100.00', ...body });
  const adjust = (user, body) => post(user, `/api/v1/cashiering/folios/${folio.id}/adjustments`, { description: 'Goodwill', amount: '-500.00', reason: 'Guest complaint', ...body });
  const lineCount = async () => Number((await t.trx('folio_line_items').where({ folio_id: folio.id }).count({ n: '*' }).first()).n);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await setRole(frontDesk(), 'front_desk');
    await setRole(manager(), 'manager');
  });

  beforeEach(async () => {
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BD });
    await t.trx('night_audit_runs').where({ property_id: propertyId, business_date: CLOSED }).del();
    await t.trx('night_audit_runs').insert({ tenant_id: ctx.a.id, property_id: propertyId, business_date: CLOSED, status: 'COMPLETED', worker_id: 'test', heartbeat_at: new Date(), started_at: new Date(), completed_at: new Date() });
    folio = await openFolio();
  });

  describe('charge amount', () => {
    it.each([['-5000'], ['-0.01'], ['0'], ['0.00'], ['abc'], ['NaN'], ['Infinity'], ['1e3'], ['12.345'], ['1,000'], [''], ['   '], [-5], [true], [{ a: 1 }], ['99999999999.00']])(
      'refuses the amount %j and posts nothing',
      async (amount) => {
        const res = await charge(frontDesk(), { amount });
        expect({ amount, status: res.status, code: res.body.error?.code }).toEqual({ amount, status: 400, code: 'VALIDATION_INVALID_AMOUNT' });
        expect(await lineCount()).toBe(0);
        expect((await t.trx('folios').where({ id: folio.id }).first()).balance).toBe('0.00');
      }
    );

    it('still posts an ordinary positive charge, with tax, on the business date', async () => {
      const res = await charge(frontDesk(), { amount: '100.00' });
      expect(res.status).toBe(201);
      expect(String(res.body.data.business_date).slice(0, 10)).toBe(BD);
    });

    it('a negative amount is an adjustment: refused to front desk, allowed with cashiering.void_line and a reason, and audited', async () => {
      expect((await adjust(frontDesk(), {})).status).toBe(403);
      expect(await lineCount()).toBe(0);

      const noReason = await adjust(manager(), { reason: undefined });
      expect(noReason.status).toBe(400);

      const ok = await adjust(manager(), {});
      expect(ok.status).toBe(201);
      expect(ok.body.data.amount).toBe('-500.00');
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'folio_line_items', action: 'post_adjustment' }).orderBy('id', 'desc').first();
      expect(audit.reason).toBe('Guest complaint');
      expect(String(audit.user_id)).toBe(String(manager().id));
    });

    it.each([['0'], ['0.00'], ['abc'], ['1e3'], ['-0'], ['12.345'], ['99999999999.00']])('refuses the adjustment amount %j', async (amount) => {
      const res = await adjust(manager(), { amount });
      expect({ amount, status: res.status, code: res.body.error?.code }).toEqual({ amount, status: 400, code: 'VALIDATION_INVALID_AMOUNT' });
      expect(await lineCount()).toBe(0);
    });
  });

  describe('client business_date on a charge', () => {
    const bdOf = (res) => String(res.body.data.business_date).slice(0, 10);

    it('defaults to the current business date when none is sent', async () => {
      expect(bdOf(await charge(frontDesk(), {}))).toBe(BD);
    });

    it('accepts exactly the current business date from front desk', async () => {
      const res = await charge(frontDesk(), { business_date: BD });
      expect(res.status).toBe(201);
      expect(bdOf(res)).toBe(BD);
    });

    it.each([['tomorrow'], ['2027-02-30'], ['2027-13-01'], ['10/03/2027'], [20270310], [''], [{ a: 1 }]])('refuses the malformed date %j', async (business_date) => {
      const res = await charge(manager(), { business_date });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_BUSINESS_DATE');
      expect(await lineCount()).toBe(0);
    });

    it('refuses a future date for everyone, even a user who may back-date', async () => {
      for (const user of [frontDesk(), manager()]) {
        const res = await charge(user, { business_date: shiftDate(BD, 1) });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_BUSINESS_DATE_IN_FUTURE');
      }
      expect(await lineCount()).toBe(0);
    });

    it('refuses a past date without cashiering.backdate', async () => {
      const res = await charge(frontDesk(), { business_date: OPEN_PAST });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_BACKDATING');
      expect(await lineCount()).toBe(0);
    });

    it('allows a past, not-yet-audited day with cashiering.backdate and marks the audit row', async () => {
      const res = await charge(manager(), { business_date: OPEN_PAST });
      expect(res.status).toBe(201);
      expect(bdOf(res)).toBe(OPEN_PAST);
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'folio_line_items', action: 'post_charge' }).orderBy('id', 'desc').first();
      const after = typeof audit.after_state === 'string' ? JSON.parse(audit.after_state) : audit.after_state;
      expect(after.backdated).toBe(true);
    });

    it('refuses a day Night Audit has closed, for everyone, even with cashiering.backdate', async () => {
      for (const user of [frontDesk(), manager()]) {
        const res = await charge(user, { business_date: CLOSED });
        expect([403, 422]).toContain(res.status);
      }
      const res = await charge(manager(), { business_date: CLOSED });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_BUSINESS_DAY_CLOSED');
      expect(await lineCount()).toBe(0);
    });

    it('also treats a day with a daily_reports snapshot as closed', async () => {
      const day = '2027-03-07';
      const [runId] = await t.trx('night_audit_runs').insert({ tenant_id: ctx.a.id, property_id: propertyId, business_date: day, status: 'FAILED', worker_id: 'test', heartbeat_at: new Date(), started_at: new Date() });
      await t.trx('daily_reports').insert({
        tenant_id: ctx.a.id, property_id: propertyId, night_audit_run_id: runId, business_date: day,
        room_revenue: '0.00', pos_revenue: '0.00', payments_collected: '0.00', occupancy_pct: '0.00', adr: '0.00', revpar: '0.00',
      });
      const res = await charge(manager(), { business_date: day });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_BUSINESS_DAY_CLOSED');
    });

    it('uses the BUSINESS date, not the calendar date: between midnight and Night Audit they differ', async () => {
      // After midnight, before the audit: the calendar has moved to the next day, the business date has not.
      const calendarToday = new Date().toISOString().slice(0, 10);
      const yesterday = shiftDate(calendarToday, -1);
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: yesterday });

      // The calendar date is "tomorrow" as far as the books are concerned: refused, for everyone.
      for (const user of [frontDesk(), manager()]) {
        const res = await charge(user, { business_date: calendarToday });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_BUSINESS_DATE_IN_FUTURE');
      }
      // The business date (yesterday on the calendar) is the open day: allowed, and it is the default.
      const explicit = await charge(frontDesk(), { business_date: yesterday });
      expect(explicit.status).toBe(201);
      expect(bdOf(explicit)).toBe(yesterday);
      const implicit = await charge(frontDesk(), {});
      expect(bdOf(implicit)).toBe(yesterday);

      // After Night Audit the business date moves on; the same calendar date is now the open day...
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: calendarToday });
      expect(bdOf(await charge(frontDesk(), { business_date: calendarToday }))).toBe(calendarToday);
      // ...and yesterday is now a past day: front desk may no longer post to it.
      const late = await charge(frontDesk(), { business_date: yesterday });
      expect(late.status).toBe(403);
    });
  });

  describe('the same rules on payments and adjustments', () => {
    const cash = (user, body) => post(user, `/api/v1/cashiering/folios/${folio.id}/payments/cash`, { amount: '10.00', currency: 'NGN', ...body });
    const terminal = (user, body) => post(user, `/api/v1/cashiering/folios/${folio.id}/payments/terminal`, { amount: '10.00', currency: 'NGN', ...body });

    it.each([['cash', cash], ['terminal', terminal]])('a %s payment: future refused, past needs backdate, closed refused, current accepted', async (_name, take) => {
      expect((await take(manager(), { business_date: shiftDate(BD, 1) })).status).toBe(400);
      expect((await take(manager(), { business_date: CLOSED })).status).toBe(422);
      expect((await take(manager(), { business_date: OPEN_PAST })).status).toBe(201);
      expect((await take(manager(), { business_date: BD })).status).toBe(201);
    });

    it('a cashier without cashiering.backdate cannot back-date a payment', async () => {
      await setRole(frontDesk(), 'cashier');
      try {
        const res = await cash(frontDesk(), { business_date: OPEN_PAST });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_BACKDATING');
        expect((await cash(frontDesk(), { business_date: BD })).status).toBe(201);
      } finally {
        await setRole(frontDesk(), 'front_desk');
      }
    });

    it('an adjustment follows the same date rule', async () => {
      expect((await adjust(manager(), { business_date: shiftDate(BD, 1) })).status).toBe(400);
      expect((await adjust(manager(), { business_date: CLOSED })).status).toBe(422);
      expect((await adjust(manager(), { business_date: OPEN_PAST })).status).toBe(201);
    });
  });
});
