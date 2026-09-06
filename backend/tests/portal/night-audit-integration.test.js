'use strict';

/**
 * Proves the actual design claim `src/modules/portal/service.js`'s own
 * header makes: posting one real charge PER NIGHT at booking time (each
 * dated to its own `stay_date`) means Night Audit's own idempotency guard
 * (`src/modules/night-audit/service.js`'s step 4 — skip a folio that
 * already has a non-voided `room_charge` for that exact `business_date`)
 * correctly finds every night of a portal-booked stay already accounted
 * for once the guest checks in and Night Audit runs across those dates —
 * rather than double-billing nights 2..N, which an aggregate single-charge
 * design would have done.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => ({
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  refundTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystack = require('../../src/modules/cashiering/paystack-adapter');

describe('Portal booking + Night Audit non-collision (PLAN.md Phase 4)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  function staffTokenFor(propertyId) {
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(propertyId),
    });
  }

  it('does not double-post a room charge for any night already prepaid through the portal', async () => {
    const suffix = `${Date.now()}`;
    const [propertyId] = await t.trx('properties').insert({
      tenant_id: ctx.a.id,
      slug: `na-portal-${suffix}`,
      name: 'NA Portal Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-03-01',
    });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: ctx.a.users[0].id, role: 'manager' });

    const [roomTypeId] = await t.trx('room_types').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      code: `NAPT-${suffix}`,
      name: 'NA Portal Room',
      default_occupancy: 2,
      base_rate: '150.00',
    });
    const [roomId] = await t.trx('rooms').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      room_type_id: roomTypeId,
      room_number: '1',
      status: 'active',
      housekeeping_reported_status: 'clean',
    });
    const [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      code: `NAPTRATE-${suffix}`,
      base_rate: '150.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    const property = await t.trx('properties').where({ id: propertyId }).first('slug');

    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/na', accessCode: 'a', reference: 'r' });

    const create = await t.request
      .post('/api/v1/portal/bookings')
      .set('X-Tenant-Slug', ctx.a.slug)
      .set('Idempotency-Key', `na-portal-key-${suffix}`)
      .send({
        property_slug: property.slug,
        room_type_id: String(roomTypeId),
        rate_code_id: String(rateCodeId),
        arrival_date: '2027-03-01',
        departure_date: '2027-03-03', // two nights: 03-01 and 03-02
        first_name: 'NA',
        last_name: 'Portal',
        email: `na-portal-${suffix}@example.com`,
      });
    expect(create.status).toBe(201);
    const reservationId = create.body.data.reservation.id;
    const folioId = create.body.data.folio.id;

    paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'ref', providerPaymentId: 'ps_na', amountSubunit: 1, currency: 'NGN' });
    await t.request
      .post(`/api/v1/portal/bookings/${create.body.data.reservation.confirmation_number}/confirm`)
      .set('X-Tenant-Slug', ctx.a.slug)
      .send({ property_slug: property.slug });

    const chargesBeforeCheckIn = await t.trx('folio_line_items').where({ folio_id: folioId, type: 'room_charge' });
    expect(chargesBeforeCheckIn.length).toBe(2);

    const checkIn = await t.request
      .post(`/api/v1/reservations/${reservationId}/check-in`)
      .set('Authorization', `Bearer ${staffTokenFor(propertyId)}`)
      .set('Idempotency-Key', `na-portal-checkin-${suffix}`)
      .send({ room_id: String(roomId) });
    expect(checkIn.status).toBe(200);

    // Night Audit for the first night — the portal already posted this
    // night's charge, so this must skip it, not double-post.
    const run1 = await t.request
      .post('/api/v1/night-audit/run')
      .set('Authorization', `Bearer ${staffTokenFor(propertyId)}`)
      .send({});
    expect(run1.status).toBe(200);

    const chargesAfterRun1 = await t.trx('folio_line_items').where({ folio_id: folioId, type: 'room_charge' }).whereNull('voided_at');
    expect(chargesAfterRun1.length).toBe(2); // unchanged — still exactly one per night, not three

    // Night Audit for the second (final) night — same non-collision proof.
    const run2 = await t.request
      .post('/api/v1/night-audit/run')
      .set('Authorization', `Bearer ${staffTokenFor(propertyId)}`)
      .send({});
    expect(run2.status).toBe(200);

    const chargesAfterRun2 = await t.trx('folio_line_items').where({ folio_id: folioId, type: 'room_charge' }).whereNull('voided_at');
    expect(chargesAfterRun2.length).toBe(2); // still unchanged

    const finalProperty = await t.trx('properties').where({ id: propertyId }).first('current_business_date');
    expect(String(finalProperty.current_business_date)).toBe('2027-03-03'); // advanced through both nights
  });
});
