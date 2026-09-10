'use strict';

/**
 * Real-concurrency tests for Accounts Receivable — ARCHITECTURE.md §5, the
 * same discipline `tests/reservations/concurrency.test.js` (RES-5) and
 * `tests/pos/concurrency.test.js` established: a shared, rolled-back
 * transaction (`useTestApp()`, every other test file in this suite) cannot
 * prove a real lock, since two "concurrent" requests against it are really
 * two savepoints on the same MySQL session, and a session never blocks
 * itself. This file binds the app to the real POOLED test connection
 * instead and seeds real COMMITTED rows, cleaned up in `afterAll` — see
 * `tests/reservations/concurrency.test.js`'s own header for the full
 * reasoning, unchanged here.
 *
 * Three races. The first two are serialized by the SAME lock —
 * `assertWithinCreditLimit`'s `SELECT ... FOR UPDATE` on the `ar_accounts`
 * row (`src/modules/ar/service.js`'s own file header):
 *
 *   1. Two concurrent charges against the same account, together exceeding
 *      a block-mode credit limit — exactly one must succeed.
 *   2. Two concurrent "generate an invoice" calls against the same account
 *      with exactly one eligible charge — exactly one must produce a real
 *      invoice; the other finds nothing left to invoice.
 *
 * The third is serialized by a different lock — `applyPaymentApplications`'s
 * `.forUpdate()` reads against `ar_invoices`/`ar_payment_applications`
 * (found and fixed by code review after the initial implementation: those
 * reads were originally plain SELECTs, which kept seeing a stale
 * REPEATABLE READ snapshot even after the `ar_invoices` row lock was taken,
 * the identical bug class `recomputeArAccountBalance`'s own header already
 * documents fixing once for the account balance):
 *
 *   3. Two concurrent "apply a payment to this invoice" calls, each alone
 *      valid but together exceeding the invoice's total — exactly one must
 *      succeed.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

describe('AR: real concurrency', () => {
  let req;
  let tenantId;
  let propertyId;
  let roleId;
  let userId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    [tenantId] = await db()('tenants').insert({ name: 'AR Concurrency Tenant', slug: `ar-concurrency-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `ar-concurrency-property-${suffix}`,
      name: 'AR Concurrency Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-03-01',
    });
    [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `ar-concurrency-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Concurrency',
      last_name: 'User',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });

    // cashiering.post_charge/.void_line and ar.manage are all real,
    // migration-seeded keys — grant, don't create.
    const perms = await db()('permissions').whereIn('permission_key', ['cashiering.post_charge', 'cashiering.void_line', 'ar.manage', 'ar.view']).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
  });

  async function seedGuestAndRoomType(suffix) {
    const [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'Race', last_name: 'Guest' });
    const [roomTypeId] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: `RC${suffix}`,
      name: 'Race Room Type',
      default_occupancy: 2,
      base_rate: '100.00',
    });
    const [rateCodeId] = await db()('rate_codes').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: `RCRATE${suffix}`,
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    const [reservationId] = await db()('reservations').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      guest_id: guestId,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: '2027-03-01',
      departure_date: '2027-03-02',
      adults: 1,
      children: 0,
      status: 'confirmed',
      confirmation_number: `ARRACE-${suffix}`,
    });
    return { guestId, roomTypeId, rateCodeId, reservationId };
  }

  afterAll(async () => {
    // Child-to-parent: ar_invoice_lines/ar_payment_applications reference
    // folio_line_items/ar_invoices/ar_payments; folios/ar_accounts
    // reference company_profiles — company_profiles must be deleted LAST
    // among this group, not before the rows that still reference it.
    await db()('ar_invoice_lines').where({ tenant_id: tenantId }).delete();
    await db()('ar_payment_applications').where({ tenant_id: tenantId }).delete();
    await db()('ar_invoices').where({ tenant_id: tenantId }).delete();
    await db()('ar_payments').where({ tenant_id: tenantId }).delete();
    await db()('ar_invoice_sequences').where({ tenant_id: tenantId }).delete();
    await db()('ar_accounts').where({ tenant_id: tenantId }).delete();
    await db()('folio_line_items').where({ tenant_id: tenantId }).delete();
    await db()('folios').where({ tenant_id: tenantId }).delete();
    await db()('company_profiles').where({ tenant_id: tenantId }).delete();
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('outbox_events').where({ tenant_id: tenantId }).delete();
    await db()('idempotency_keys').where({ tenant_id: tenantId }).delete();
    await db()('reservation_daily_rates').where({ tenant_id: tenantId }).delete();
    await db()('room_type_inventory').where({ tenant_id: tenantId }).delete();
    await db()('reservations').where({ tenant_id: tenantId }).delete();
    await db()('rate_codes').where({ tenant_id: tenantId }).delete();
    await db()('room_types').where({ tenant_id: tenantId }).delete();
    await db()('guests').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  function token() {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  }

  it('exactly one of two truly concurrent charges that together exceed a block-mode credit limit succeeds; the account balance reflects only the winner', async () => {
    const [companyProfileId] = await db()('company_profiles').insert({ tenant_id: tenantId, name: 'Race Co (charge test)' });
    const { reservationId } = await seedGuestAndRoomType('CHG');
    const [folioId] = await db()('folios').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `ARRACEFOLIO-CHG`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Race Co',
      company_profile_id: companyProfileId,
    });
    const [accountId] = await db()('ar_accounts').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      company_profile_id: companyProfileId,
      credit_limit: '100.00',
      currency: 'NGN',
      enforcement_mode: 'block',
    });

    const postCharge = (key) =>
      req
        .post(`/api/v1/cashiering/folios/${folioId}/adjustments`)
        .set('Authorization', `Bearer ${token()}`)
        .set('Idempotency-Key', key)
        .send({ description: 'Race charge', amount: '60.00', reason: 'Race test' });

    const [first, second] = await Promise.all([postCharge('ar-race-charge-1'), postCharge('ar-race-charge-2')]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 422]);

    const winner = first.status === 201 ? first : second;
    const loser = first.status === 201 ? second : first;
    expect(winner.body.data.amount).toBe('60.00');
    expect(loser.body.error.code).toBe('BUSINESS_RULE_CREDIT_LIMIT_EXCEEDED');

    const account = await db()('ar_accounts').where({ id: accountId }).first();
    expect(account.current_balance).toBe('60.00');

    const lineCount = await db()('folio_line_items').where({ folio_id: folioId }).whereNull('voided_at').count({ n: '*' }).first();
    expect(Number(lineCount.n)).toBe(1);
  });

  it('exactly one of two truly concurrent "generate invoice" calls against the same account produces a real invoice; the other finds nothing left to invoice', async () => {
    const [companyProfileId] = await db()('company_profiles').insert({ tenant_id: tenantId, name: 'Race Co (invoice test)' });
    const { reservationId } = await seedGuestAndRoomType('INV');
    const [folioId] = await db()('folios').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `ARRACEFOLIO-INV`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Race Co',
      company_profile_id: companyProfileId,
    });
    const [accountId] = await db()('ar_accounts').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      company_profile_id: companyProfileId,
      credit_limit: '500.00',
      currency: 'NGN',
      enforcement_mode: 'block',
    });
    await db()('folio_line_items').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      folio_id: folioId,
      type: 'room_charge',
      description: 'The one eligible charge',
      amount: '30.00',
      currency: 'NGN',
      business_date: '2027-03-01',
    });

    const generateInvoice = (key) =>
      req
        .post(`/api/v1/ar/accounts/${accountId}/invoices`)
        .set('Authorization', `Bearer ${token()}`)
        .set('Idempotency-Key', key)
        .send({});

    const [first, second] = await Promise.all([generateInvoice('ar-race-invoice-1'), generateInvoice('ar-race-invoice-2')]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 422]);

    const winner = first.status === 201 ? first : second;
    const loser = first.status === 201 ? second : first;
    expect(winner.body.data.total_amount).toBe('30.00');
    expect(loser.body.error.code).toBe('VALIDATION_NO_CHARGES_TO_INVOICE');

    const invoiceCount = await db()('ar_invoices').where({ ar_account_id: accountId }).count({ n: '*' }).first();
    expect(Number(invoiceCount.n)).toBe(1);

    const lineCount = await db()('ar_invoice_lines').where({ ar_invoice_id: winner.body.data.id }).count({ n: '*' }).first();
    expect(Number(lineCount.n)).toBe(1);
  });

  it('exactly one of two truly concurrent payment applications that together exceed an invoice total succeeds', async () => {
    const [companyProfileId] = await db()('company_profiles').insert({ tenant_id: tenantId, name: 'Race Co (apply test)' });
    const { reservationId } = await seedGuestAndRoomType('APP');
    const [folioId] = await db()('folios').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `ARRACEFOLIO-APP`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Race Co',
      company_profile_id: companyProfileId,
    });
    const [accountId] = await db()('ar_accounts').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      company_profile_id: companyProfileId,
      credit_limit: '500.00',
      currency: 'NGN',
      enforcement_mode: 'block',
    });
    await db()('folio_line_items').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      folio_id: folioId,
      type: 'room_charge',
      description: 'The invoiced charge',
      amount: '100.00',
      currency: 'NGN',
      business_date: '2027-03-01',
    });

    const generateRes = await req
      .post(`/api/v1/ar/accounts/${accountId}/invoices`)
      .set('Authorization', `Bearer ${token()}`)
      .set('Idempotency-Key', 'ar-race-apply-generate')
      .send({});
    const invoiceId = generateRes.body.data.id;

    // Two separate, fully-unapplied payments — either one alone can cover the
    // whole 100.00 invoice, but applying both in full would double-cover it.
    const [paymentAId] = await db()('ar_payments').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      ar_account_id: accountId,
      amount: '100.00',
      currency: 'NGN',
      method_label: 'wire',
      reference: 'RACE-A',
      received_at: '2027-03-02',
      business_date: '2027-03-02',
    });
    const [paymentBId] = await db()('ar_payments').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      ar_account_id: accountId,
      amount: '100.00',
      currency: 'NGN',
      method_label: 'wire',
      reference: 'RACE-B',
      received_at: '2027-03-02',
      business_date: '2027-03-02',
    });

    const applyPayment = (paymentId, key) =>
      req
        .post(`/api/v1/ar/payments/${paymentId}/apply`)
        .set('Authorization', `Bearer ${token()}`)
        .set('Idempotency-Key', key)
        .send({ applications: [{ invoice_id: invoiceId, amount: '100.00' }] });

    const [first, second] = await Promise.all([applyPayment(paymentAId, 'ar-race-apply-1'), applyPayment(paymentBId, 'ar-race-apply-2')]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 422]);

    const loser = first.status === 200 ? second : first;
    expect(loser.body.error.code).toBe('BUSINESS_RULE_PAYMENT_APPLICATION_EXCEEDS_INVOICE');

    const invoice = await db()('ar_invoices').where({ id: invoiceId }).first();
    expect(invoice.status).toBe('paid');

    const applications = await db()('ar_payment_applications').where({ ar_invoice_id: invoiceId }).whereNull('voided_at');
    expect(applications).toHaveLength(1);
    expect(applications[0].amount).toBe('100.00');
  });
});
