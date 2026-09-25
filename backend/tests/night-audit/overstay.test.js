'use strict';

/**
 * User-reported: "a client lodged to a room since the 16th, departure date is
 * the 19th, he stayed more days than that, the money didn't increase as new
 * day after night audit is run." Two separate causes, both covered here:
 *
 *  1. Night Audit only billed nights that had a `reservation_daily_rates` row
 *     fixed at booking time, so a guest still in-house past their departure
 *     date was silently free. It now bills the overstay night at the guest's
 *     last nightly rate and moves their departure to the next day.
 *  2. Extend Stay added rate rows for nights whose audit had already run, and
 *     Night Audit never runs a closed date again, so those nights were never
 *     billed at all (the "missing 17th night"). They are now charged at once as
 *     late room charges on the current business date.
 *
 * Dates are in 2019 for the reason night-audit.test.js explains (the premature-
 * run guard), and every property/reservation here is its own fresh fixture.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Night Audit and Extend Stay: overstaying guests', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  function tokenFor(propertyId) {
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(propertyId),
    });
  }

  /**
   * A property whose business date is `businessDate`, with one checked-in guest
   * booked for the nights in `bookedNights` (each at `rate`) and departing on
   * `departureDate`.
   */
  async function inHouseGuest({ businessDate, departureDate, bookedNights, rate = '75.00' }) {
    const tenant = ctx.a;
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const [propertyId] = await t.trx('properties').insert({
      tenant_id: tenant.id,
      slug: `os-property-${suffix}`,
      name: 'Overstay Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: businessDate,
    });
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: tenant.users[0].id, role: 'manager' });
    const [roomTypeId] = await t.trx('room_types').insert({
      tenant_id: tenant.id, property_id: propertyId, code: `OST-${suffix}`.slice(0, 20), name: 'Overstay Type', default_occupancy: 2, base_rate: rate,
    });
    const [roomId] = await t.trx('rooms').insert({
      tenant_id: tenant.id, property_id: propertyId, room_type_id: roomTypeId, room_number: '7', status: 'active', front_desk_status: 'occupied',
    });
    const [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: tenant.id, property_id: propertyId, code: `OSR-${suffix}`.slice(0, 20), base_rate: rate, currency: 'NGN', valid_from: '2019-01-01',
    });
    const [reservationId] = await t.trx('reservations').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      guest_id: tenant.guests[0].id,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: bookedNights[0],
      departure_date: departureDate,
      adults: 1,
      children: 0,
      status: 'checked_in',
      confirmation_number: `OS${suffix}`.toUpperCase().slice(0, 26),
      checked_in_at: new Date(),
    });
    for (const stayDate of bookedNights) {
      await t.trx('reservation_daily_rates').insert({
        tenant_id: tenant.id, property_id: propertyId, reservation_id: reservationId, stay_date: stayDate, rate, currency: 'NGN',
      });
    }
    await t.trx('reservation_rooms').insert({
      tenant_id: tenant.id, property_id: propertyId, reservation_id: reservationId, room_id: roomId, effective_from: new Date(), effective_to: null,
    });
    const [folioId] = await t.trx('folios').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `OSF${suffix}`.toUpperCase().slice(0, 26),
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
    });
    return { propertyId, roomTypeId, reservationId, folioId };
  }

  const runAudit = (propertyId) => t.request.post('/api/v1/night-audit/run').set('Authorization', `Bearer ${tokenFor(propertyId)}`).send({});
  const chargesOf = (folioId) => t.trx('folio_line_items').where({ folio_id: folioId, type: 'room_charge' }).whereNull('voided_at').orderBy('id');

  describe('Night Audit bills an overstay night', () => {
    it('charges a guest still in-house past departure at their last nightly rate, and moves departure to tomorrow', async () => {
      // Booked the 2nd and 3rd, departure the 4th — but it is now the 4th and they are still here.
      const setup = await inHouseGuest({ businessDate: '2019-03-04', departureDate: '2019-03-04', bookedNights: ['2019-03-02', '2019-03-03'], rate: '75.00' });

      const res = await runAudit(setup.propertyId);
      expect(res.status).toBe(200);
      expect(res.body.data.room_revenue).toBe('75.00');
      expect(res.body.meta.exceptions).toEqual([
        { type: 'overstay_auto_extended', reservationId: String(setup.reservationId), stayDate: '2019-03-04' },
      ]);

      const lines = await chargesOf(setup.folioId);
      expect(lines).toHaveLength(1);
      expect(lines[0].amount).toBe('75.00');
      expect(lines[0].business_date).toBe('2019-03-04');

      const rates = await t.trx('reservation_daily_rates').where({ reservation_id: setup.reservationId }).orderBy('stay_date');
      expect(rates.map((r) => r.stay_date)).toEqual(['2019-03-02', '2019-03-03', '2019-03-04']);
      expect(rates[2].rate).toBe('75.00');

      const reservation = await t.trx('reservations').where({ id: setup.reservationId }).first();
      expect(reservation.departure_date).toBe('2019-03-05');
      expect(reservation.status).toBe('checked_in');

      const inventory = await t.trx('room_type_inventory').where({ room_type_id: setup.roomTypeId, stay_date: '2019-03-04' }).first();
      expect(inventory.rooms_sold).toBe(1);

      const folio = await t.trx('folios').where({ id: setup.folioId }).first();
      expect(folio.balance).toBe('75.00');
    });

    it('keeps charging every night the guest stays, not just the first', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-03-10', departureDate: '2019-03-10', bookedNights: ['2019-03-09'], rate: '60.00' });

      expect((await runAudit(setup.propertyId)).status).toBe(200); // the 10th
      expect((await runAudit(setup.propertyId)).status).toBe(200); // the 11th
      expect((await runAudit(setup.propertyId)).status).toBe(200); // the 12th

      const lines = await chargesOf(setup.folioId);
      expect(lines.map((l) => l.business_date)).toEqual(['2019-03-10', '2019-03-11', '2019-03-12']);
      const folio = await t.trx('folios').where({ id: setup.folioId }).first();
      expect(folio.balance).toBe('180.00');
      const reservation = await t.trx('reservations').where({ id: setup.reservationId }).first();
      expect(reservation.departure_date).toBe('2019-03-13');
    });

    // The reported case: the departure date passed, old-code audits closed those
    // nights without billing them, and the first audit after this fix runs on a
    // later business date. Billing only tonight and moving departure forward would
    // bury the missed nights where Extend Stay can never reach them.
    it('catches up nights the guest already stayed but was never billed for, then bills tonight', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-03-22', departureDate: '2019-03-19', bookedNights: ['2019-03-17', '2019-03-18'], rate: '50.00' });

      const res = await runAudit(setup.propertyId);
      expect(res.status).toBe(200);
      expect(res.body.meta.exceptions).toEqual([
        {
          type: 'overstay_auto_extended',
          reservationId: String(setup.reservationId),
          stayDate: '2019-03-22',
          catchUpNights: ['2019-03-19', '2019-03-20', '2019-03-21'],
        },
      ]);

      const lines = await chargesOf(setup.folioId);
      expect(lines.map((l) => l.description)).toEqual([
        'Late room charge — 2019-03-19',
        'Late room charge — 2019-03-20',
        'Late room charge — 2019-03-21',
        'Room charge — 2019-03-22',
      ]);
      const folio = await t.trx('folios').where({ id: setup.folioId }).first();
      expect(folio.balance).toBe('200.00');
      const reservation = await t.trx('reservations').where({ id: setup.reservationId }).first();
      expect(reservation.departure_date).toBe('2019-03-23');
      const rates = await t.trx('reservation_daily_rates').where({ reservation_id: setup.reservationId }).orderBy('stay_date');
      expect(rates.map((r) => r.stay_date)).toEqual(['2019-03-17', '2019-03-18', '2019-03-19', '2019-03-20', '2019-03-21', '2019-03-22']);
      // Each night counted once against inventory.
      const inventory = await t.trx('room_type_inventory').where({ room_type_id: setup.roomTypeId }).orderBy('stay_date');
      expect(inventory.map((r) => [r.stay_date, r.rooms_sold])).toEqual([
        ['2019-03-19', 1], ['2019-03-20', 1], ['2019-03-21', 1], ['2019-03-22', 1],
      ]);
    });

    it('reports a guest it cannot bill instead of skipping them silently (no nightly rate to copy)', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-03-28', departureDate: '2019-03-27', bookedNights: ['2019-03-26'] });
      await t.trx('reservation_daily_rates').where({ reservation_id: setup.reservationId }).delete();

      const res = await runAudit(setup.propertyId);
      expect(res.status).toBe(200);
      expect(res.body.meta.exceptions).toEqual([
        { type: 'overstay_without_rate', reservationId: String(setup.reservationId), stayDate: '2019-03-28' },
      ]);
      expect(await chargesOf(setup.folioId)).toHaveLength(0);
    });

    // A folio billed to a company on a block-mode account already at its limit used
    // to make `postCharge` throw, which rolled the whole audit back to FAILED on
    // every retry — the property could not close the day.
    it('still closes the day when the guest\'s folio is billed to a company over its credit limit, flagging the account', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-04-02', departureDate: '2019-04-02', bookedNights: ['2019-04-01'], rate: '75.00' });
      const [arAccountId] = await t.trx('ar_accounts').insert({
        tenant_id: ctx.a.id,
        property_id: setup.propertyId,
        company_profile_id: ctx.a.companyProfiles[0].id,
        credit_limit: '10.00',
        currency: 'NGN',
        enforcement_mode: 'block',
      });
      await t.trx('folios').where({ id: setup.folioId }).update({ company_profile_id: ctx.a.companyProfiles[0].id });

      const res = await runAudit(setup.propertyId); // the 2nd: an overstay night, 75.00 against a 10.00 limit
      expect(res.status).toBe(200);
      expect(res.body.meta.run.status).toBe('COMPLETED');
      expect(await chargesOf(setup.folioId)).toHaveLength(1);
      const account = await t.trx('ar_accounts').where({ id: arAccountId }).first();
      expect(Boolean(account.is_over_limit)).toBe(true);
    });

    it('does not touch a guest who is still within their booked nights', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-03-20', departureDate: '2019-03-23', bookedNights: ['2019-03-20', '2019-03-21', '2019-03-22'] });

      const res = await runAudit(setup.propertyId);
      expect(res.status).toBe(200);
      expect(res.body.meta.exceptions).toEqual([]);
      const reservation = await t.trx('reservations').where({ id: setup.reservationId }).first();
      expect(reservation.departure_date).toBe('2019-03-23');
      const rates = await t.trx('reservation_daily_rates').where({ reservation_id: setup.reservationId });
      expect(rates).toHaveLength(3);
      expect(await chargesOf(setup.folioId)).toHaveLength(1);
    });

    it('does not bill a guest who is not checked in, even past their departure date', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-03-25', departureDate: '2019-03-25', bookedNights: ['2019-03-24'] });
      await t.trx('reservations').where({ id: setup.reservationId }).update({ status: 'checked_out' });

      const res = await runAudit(setup.propertyId);
      expect(res.status).toBe(200);
      expect(res.body.data.room_revenue).toBe('0.00');
      expect(await chargesOf(setup.folioId)).toHaveLength(0);
    });
  });

  describe('Extend Stay charges nights that were already audited', () => {
    const extend = (propertyId, reservationId, newDepartureDate) =>
      t.request
        .post(`/api/v1/reservations/${reservationId}/extend-stay`)
        .set('Authorization', `Bearer ${tokenFor(propertyId)}`)
        .set('Idempotency-Key', `os-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
        .send({ new_departure_date: newDepartureDate });

    it('bills the closed nights at once, on the current business date, and leaves tonight for Night Audit', async () => {
      // One night booked (the 17th), departing the 18th. The business date is
      // already the 20th: the 18th and 19th are audited days that will never be billed.
      const setup = await inHouseGuest({ businessDate: '2019-04-20', departureDate: '2019-04-18', bookedNights: ['2019-04-17'], rate: '100.00' });

      const res = await extend(setup.propertyId, setup.reservationId, '2019-04-21');
      expect(res.status).toBe(200);
      expect(res.body.data.departure_date).toBe('2019-04-21');
      expect(res.body.data.late_charged_nights.map((n) => n.stayDate)).toEqual(['2019-04-18', '2019-04-19']);

      const lines = await chargesOf(setup.folioId);
      expect(lines.map((l) => l.description)).toEqual(['Late room charge — 2019-04-18', 'Late room charge — 2019-04-19']);
      expect(lines.every((l) => l.business_date === '2019-04-20' && l.amount === '100.00')).toBe(true);
      const folio = await t.trx('folios').where({ id: setup.folioId }).first();
      expect(folio.balance).toBe('200.00');
    });

    it('still lets Night Audit bill tonight, even though late charges are dated the same business date', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-04-20', departureDate: '2019-04-18', bookedNights: ['2019-04-17'], rate: '100.00' });
      await extend(setup.propertyId, setup.reservationId, '2019-04-21'); // adds the 18th, 19th (closed) and the 20th (tonight)

      const res = await runAudit(setup.propertyId);
      expect(res.status).toBe(200);
      expect(res.body.data.room_revenue).toBe('300.00'); // 2 late charges + tonight's, all dated the 20th

      const lines = await chargesOf(setup.folioId);
      expect(lines).toHaveLength(3);
      expect(lines.filter((l) => l.description === 'Room charge — 2019-04-20')).toHaveLength(1);
      const folio = await t.trx('folios').where({ id: setup.folioId }).first();
      expect(folio.balance).toBe('300.00');
    });

    it('extends over a past night even when that night was already full — the guest was physically there', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-04-12', departureDate: '2019-04-10', bookedNights: ['2019-04-09'], rate: '100.00' });
      // The 10th is at its sell limit for this room type (1 room, someone else holds it).
      await t.trx('room_type_inventory').insert({
        tenant_id: ctx.a.id, property_id: setup.propertyId, room_type_id: setup.roomTypeId, stay_date: '2019-04-10', rooms_sold: 1, overbooking_threshold_pct: 100,
      });

      const res = await extend(setup.propertyId, setup.reservationId, '2019-04-13');
      expect(res.status).toBe(200);
      expect(res.body.data.late_charged_nights.map((n) => n.stayDate)).toEqual(['2019-04-10', '2019-04-11']);
    });

    it('posts nothing late when every added night is today or later', async () => {
      const setup = await inHouseGuest({ businessDate: '2019-04-30', departureDate: '2019-04-30', bookedNights: ['2019-04-29'] });

      const res = await extend(setup.propertyId, setup.reservationId, '2019-05-02');
      expect(res.status).toBe(200);
      expect(res.body.data.late_charged_nights).toEqual([]);
      expect(await chargesOf(setup.folioId)).toHaveLength(0);
    });
  });
});
