'use strict';

/**
 * ARCHITECTURE.md §6 ("Business date ≠ wall clock"), the specific gate
 * PLAN.md's Phase 2.5 "Tests required to close" list names and flags as
 * "not separately tested this pass": "Business-date boundaries: check-ins
 * at 23:59 and 00:01 post to the correct business date in a property whose
 * timezone differs from the server's."
 *
 * Every business_date in this codebase already comes from the single
 * stored `properties.current_business_date` column
 * (`src/modules/cashiering/service.js`, `src/modules/reservations/service.js`)
 * — never derived from `new Date()` or any wall-clock/timezone computation
 * at request time. This file proves that invariant for the two real code
 * paths that consult it: charge posting (a business_date is stamped onto
 * the posted row) and check-in (business_date drives the out-of-order-
 * period comparison that can block it).
 *
 * The property here is given a timezone about as far from a real CI
 * server's own (UTC or US Pacific) as a real IANA zone gets, and a
 * `current_business_date` picked to be nowhere near whatever "today" the
 * suite happens to run on. Both assertions below can only pass if the code
 * truly never touches wall-clock time — this is what actually stands in
 * for "run this test at 23:59 and 00:01," since the code path is identical
 * regardless of which moment it runs at; the meaningful proof is that it
 * NEVER reads the moment at all.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Business date is never derived from wall-clock time or timezone (ARCHITECTURE.md §6)', () => {
  const t = useTestApp();
  let ctx;

  const FIXED_BUSINESS_DATE = '2019-03-15';

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({
      timezone: 'Pacific/Kiritimati', // UTC+14
      current_business_date: FIXED_BUSINESS_DATE,
    });
  });

  function tokenFor() {
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(ctx.a.properties[0].id),
    });
  }

  it('posts a charge stamped with the property\'s stored business_date, never wall-clock "today"', async () => {
    const [folioId] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      reservation_id: ctx.a.reservations[0].id,
      folio_number: 'BDTZ-TEST-1',
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Guest',
    });

    const res = await t.request
      .post(`/api/v1/cashiering/folios/${folioId}/charges`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .set('Idempotency-Key', 'bdtz-charge-1')
      .send({ type: 'room_charge', description: 'Room', amount: '50.00' });
    expect(res.status).toBe(201);

    const line = await t.trx('folio_line_items').where({ id: res.body.data.id }).first();
    expect(String(line.business_date)).toBe(FIXED_BUSINESS_DATE);
    // Never wall-clock "today," in any timezone the test runner itself is in.
    expect(String(line.business_date)).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it("blocks check-in against the property's stored business_date, never wall-clock \"today\"", async () => {
    const [roomTypeId] = await t.trx('room_types').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: 'BDTZ',
      name: 'BDTZ',
      default_occupancy: 2,
      base_rate: '100.00',
    });
    const [roomId] = await t.trx('rooms').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      room_type_id: roomTypeId,
      room_number: 'BDTZ1',
      housekeeping_reported_status: 'clean',
    });
    // Covers ONLY the property's stored business date — deliberately not
    // whatever the server's real wall-clock "today" is, so a wall-clock-
    // derived comparison would wrongly find no conflict here.
    await t.trx('out_of_order_periods').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      room_id: roomId,
      type: 'ooo',
      reason: 'Business-date timezone test',
      start_date: FIXED_BUSINESS_DATE,
      end_date: FIXED_BUSINESS_DATE,
      created_by_user_id: ctx.a.users[0].id,
    });
    await t.trx('rooms').where({ id: roomId }).update({ has_discrepancy: false });

    const [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: 'BDTZRATE',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2019-01-01',
    });
    const [reservationId] = await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      guest_id: ctx.a.guests[0].id,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: '2019-03-15',
      departure_date: '2019-03-16',
      status: 'confirmed',
      confirmation_number: 'BDTZRES0000000000000001',
    });

    const res = await t.request
      .post(`/api/v1/reservations/${reservationId}/check-in`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .set('Idempotency-Key', 'bdtz-checkin-1')
      .send({ room_id: String(roomId) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_ROOM_OUT_OF_ORDER');
  });
});
