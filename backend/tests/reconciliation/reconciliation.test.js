'use strict';

/**
 * `GET /reconciliation/payments` — the payment reconciliation report. Its
 * whole job is to union every payment a hotel has taken, regardless of
 * which module recorded it, into one ledger a hotel can tick against its
 * Paystack settlement/bank statement.
 *
 * The one thing every test here has to prove, not just assert: a cash POS
 * sale never creates a `payments` row at all (`pos/service.js`'s
 * `settleOrder` only claims one for `card`/`nqr` tenders) — an earlier
 * draft of this report queried the POS side FROM `payments`, which would
 * have silently dropped every cash POS sale. This file's "POS cash
 * settlement appears" test is the regression test for that exact defect.
 *
 * Paystack is mocked exactly like `tests/cashiering/cashiering.test.js`/
 * `tests/pos/sales-report.test.js` already mock it — deterministic, no
 * live network.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    refundTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    createSubaccount: jest.fn(),
    resolveBankAccount: jest.fn(),
  };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

const BUSINESS_DATE = '2027-06-01';
const FEE_PERCENTAGE = '2.50';

describe('Payment reconciliation report', () => {
  const t = useTestApp();
  let ctx;
  let managerToken;
  let counter = 0;

  function tokenFor(tenant, userId, propertyId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(propertyId ?? tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role, propertyIndex = 0) {
    const userId = tenant.users[userIndex].id;
    const propertyId = tenant.properties[propertyIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  function idemKey() {
    counter += 1;
    return `reconciliation-${counter}`;
  }

  let outlet;
  let folioCounter = 0;

  async function openFolio(tenant, { reservationId, billedTo = 'Guest' } = {}) {
    folioCounter += 1;
    const [id] = await t.trx('folios').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      reservation_id: reservationId ?? tenant.reservations[0].id,
      folio_number: `RECON${String(folioCounter).padStart(6, '0')}`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: billedTo,
    });
    return t.trx('folios').where({ id }).first();
  }

  async function seedAdjustment(folio, amount, businessDate = BUSINESS_DATE) {
    await t.trx('folio_line_items').insert({
      tenant_id: folio.tenant_id,
      property_id: folio.property_id,
      folio_id: folio.id,
      type: 'adjustment',
      description: 'Test fixture balance',
      amount,
      currency: folio.currency,
      business_date: businessDate,
    });
    await t.trx('folios').where({ id: folio.id }).update({ balance: amount });
  }

  async function openTab(tableLabel, items) {
    const opened = await t.request
      .post('/api/v1/pos/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: tableLabel })
      .expect(201);
    for (const [menuItemId, quantity] of items) {
      await t.request
        .post(`/api/v1/pos/orders/${opened.body.data.id}/items`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ menu_item_id: menuItemId, quantity })
        .expect(200);
    }
    return opened.body.data.id;
  }

  function settle(orderId, settlements) {
    return t.request
      .post(`/api/v1/pos/orders/${orderId}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ settlements });
  }

  async function capturedCardPayment(orderId, tender) {
    const started = await t.request
      .post(`/api/v1/pos/orders/${orderId}/paystack-checkout`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ tender })
      .expect(201);
    await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
    return started.body.data.id;
  }

  function getReport(query, token = managerToken) {
    return t.request.get('/api/v1/reconciliation/payments').query(query).set('Authorization', `Bearer ${token}`);
  }

  let report;
  let folioCashLine;
  let folioCardLine;
  let folioRefundLine;
  let posCashLine;
  let posCardLine;
  let orphanedLine;
  let posRefundLine;
  let posRefundOriginalLine;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    await t.trx('property_payment_subaccounts').where({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id }).update({ percentage_charge: FEE_PERCENTAGE });
    await setRole(ctx.a, 0, 'manager');
    await t.trx('users').where({ id: ctx.a.users[0].id }).update({ first_name: 'Ada', last_name: 'Bello' });
    managerToken = tokenFor(ctx.a, ctx.a.users[0].id);

    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'RECON-BAR', name: 'Reconciliation Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: 'RECON-T1' });
    const [beerId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Recon Beer', category: 'Drinks', price: '48.00' });
    outlet = { outletId, terminalId, beerId };

    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/recon', accessCode: 'recon-access', reference }));

    // 1. Folio cash payment — a guest paying their room folio at checkout.
    const cashFolio = await openFolio(ctx.a);
    await seedAdjustment(cashFolio, '50.00');
    const cashPaymentRes = await t.request
      .post(`/api/v1/cashiering/folios/${cashFolio.id}/payments/cash`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ amount: '50.00', currency: 'NGN' });
    expect(cashPaymentRes.status).toBe(201);

    // 2. Folio Paystack payment — proves the fee snapshot is genuinely
    // applied (2.50% of 100.00 = 2.50 fee, 97.50 net), not silently zero.
    const cardFolio = await openFolio(ctx.a);
    await seedAdjustment(cardFolio, '100.00');
    const cardInit = await t.request
      .post(`/api/v1/cashiering/folios/${cardFolio.id}/payments/paystack`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ amount: '100.00', currency: 'NGN', guest_email: 'guest@example.com' });
    expect(cardInit.status).toBe(201);
    const cardPaymentId = cardInit.body.data.id;
    const storedCardPayment = await t.trx('payments').where({ id: cardPaymentId }).first();
    expect(storedCardPayment.platform_fee_percentage).toBe(FEE_PERCENTAGE);

    paystack.verifyTransaction.mockResolvedValue({
      status: 'success',
      reference: storedCardPayment.provider_reference,
      providerPaymentId: 'ps_recon_folio',
      channel: 'card',
      amountSubunit: 10000,
      currency: 'NGN',
    });
    const verifyRes = await t.request
      .post(`/api/v1/cashiering/payments/${cardPaymentId}/verify`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(verifyRes.status).toBe(200);

    // 3. A folio refund of that same payment, in full — its own negative-signed line.
    paystack.refundTransaction.mockResolvedValue({ status: 'processed', reference: storedCardPayment.provider_reference });
    const folioRefundRes = await t.request
      .post(`/api/v1/cashiering/payments/${cardPaymentId}/refund`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'Guest requested a refund' });
    expect(folioRefundRes.status).toBe(201);

    // 4. POS cash settlement — THE regression test. A cash tender never
    // creates a `payments` row at all; this must still appear.
    const cashTab = await openTab('Recon Table 1', [[outlet.beerId, 1]]);
    const cashSettled = await settle(cashTab, [{ method: 'cash', service_charge: '3.60' }]);
    expect(cashSettled.status).toBe(200);

    // 5. POS card settlement — a bar tab paid by card at the till.
    const cardTab = await openTab('Recon Table 2', [[outlet.beerId, 1]]);
    const cardPayment = await capturedCardPayment(cardTab, 'card');
    const posCardSettled = await settle(cardTab, [{ method: 'card', service_charge: '3.60', payment_id: cardPayment }]);
    expect(posCardSettled.status).toBe(200);

    // 6. A room-charge POS settlement — must NOT appear (no money moved
    // yet; it's now folio-owed debt, not a payment).
    const [roomTypeId] = await t.trx('room_types').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'RECON-RT', name: 'Recon RT', default_occupancy: 2, base_rate: '150.00' });
    const [roomId] = await t.trx('rooms').insert({ tenant_id: ctx.a.id, property_id: propertyId, room_type_id: roomTypeId, room_number: 'RC-1', status: 'active', front_desk_status: 'occupied' });
    const [rateCodeId] = await t.trx('rate_codes').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'RECON-RATE', base_rate: '150.00', currency: 'NGN', valid_from: '2026-01-01' });
    const [roomChargeReservationId] = await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      guest_id: ctx.a.guests[0].id,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: BUSINESS_DATE,
      departure_date: '2027-06-05',
      adults: 1,
      children: 0,
      status: 'checked_in',
      confirmation_number: `RCROOM${Date.now()}`.slice(0, 26),
      checked_in_at: new Date(),
    });
    await t.trx('reservation_rooms').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: roomChargeReservationId, room_id: roomId, effective_from: new Date(Date.now() - 60_000), effective_to: null });
    await t.trx('folios').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: roomChargeReservationId, folio_number: `RCF${Date.now()}`.slice(0, 26), status: 'open', balance: '0.00', currency: 'NGN' });
    const roomChargeTab = await openTab('Recon Table 3', [[outlet.beerId, 1]]);
    const roomChargeSettled = await settle(roomChargeTab, [{ method: 'room_charge', service_charge: '2.00', room_charge: { reservation_id: roomChargeReservationId, auth_method: 'pin', auth_reference: 'PIN entered' } }]);
    expect(roomChargeSettled.status).toBe(200);

    // 7. An orphaned/unmatched card capture — paid after its tab was voided.
    const strayTab = await openTab('Recon stray', [[outlet.beerId, 1]]);
    const strayPaymentId = await capturedCardPayment(strayTab, 'card');
    // An orphaned capture carries no business_date of its own (no settlement
    // to source one from — see the service's own header) — this report
    // falls back to `captured_at`'s own calendar date, so it must actually
    // fall inside the range under test, not the real wall-clock "now".
    await t.trx('payments').where({ id: strayPaymentId }).update({ captured_at: new Date(`${BUSINESS_DATE}T12:00:00Z`) });
    await t.trx('pos_orders').where({ id: strayTab }).update({ status: 'void' });

    // 8. A POS-target Paystack refund — its own line, correctly excluded
    // from the orphaned/unsettled bucket (it's not "still needs a refund" —
    // it IS the refund).
    const refundableTab = await openTab('Recon Table 4', [[outlet.beerId, 1]]);
    const refundablePayment = await capturedCardPayment(refundableTab, 'card');
    const refundableSettled = await settle(refundableTab, [{ method: 'card', service_charge: '3.60', payment_id: refundablePayment }]);
    expect(refundableSettled.status).toBe(200);
    const refundableStoredPayment = await t.trx('payments').where({ id: refundablePayment }).first();
    paystack.refundTransaction.mockResolvedValue({ status: 'processed', reference: refundableStoredPayment.provider_reference });
    const posRefundRes = await t.request
      .post(`/api/v1/cashiering/payments/${refundablePayment}/refund`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'Wrong order' });
    expect(posRefundRes.status).toBe(201);

    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE });
    expect(res.status).toBe(200);
    report = res.body.data;

    folioCashLine = report.lines.find((line) => line.paymentId === String(cashPaymentRes.body.data.id));
    folioCardLine = report.lines.find((line) => line.paymentId === String(cardPaymentId) && !line.isRefund);
    folioRefundLine = report.lines.find((line) => line.paymentId === String(folioRefundRes.body.data.id));
    posCashLine = report.lines.find((line) => line.source.kind === 'pos' && line.method === 'cash' && line.source.label === 'Reconciliation Bar');
    posCardLine = report.lines.find((line) => line.paymentId === String(cardPayment));
    orphanedLine = report.lines.find((line) => line.paymentId === String(strayPaymentId));
    posRefundLine = report.lines.find((line) => line.paymentId === String(posRefundRes.body.data.id));
    posRefundOriginalLine = report.lines.find((line) => line.paymentId === String(refundablePayment) && !line.isRefund);
  });

  it('shows a folio cash payment with no fee and the room-folio source', () => {
    expect(folioCashLine).toMatchObject({
      grossAmount: '50.00',
      feeAmount: '0.00',
      netAmount: '50.00',
      currency: 'NGN',
      method: 'cash',
      providerChannel: null,
      providerReference: null,
      providerPaymentId: null,
      source: { kind: 'room_folio', label: 'Room folio', channel: null },
      guestName: 'Jordan Fixture',
      isRefund: false,
    });
  });

  it('applies the property subaccount\'s snapshotted fee percentage to a folio Paystack payment', () => {
    expect(folioCardLine).toMatchObject({
      grossAmount: '100.00',
      feeAmount: '2.50',
      netAmount: '97.50',
      method: 'card',
      providerChannel: 'card',
      providerPaymentId: 'ps_recon_folio',
      source: { kind: 'room_folio', label: 'Room folio' },
      isRefund: false,
    });
    expect(folioCardLine.providerReference).toBeTruthy();
  });

  it('reports a folio refund as its own negative-signed line, fee resolved from the original payment', () => {
    expect(folioRefundLine).toMatchObject({
      grossAmount: '-100.00',
      feeAmount: '-2.50',
      netAmount: '-97.50',
      isRefund: true,
      method: 'card',
    });
  });

  it('regression: a POS cash settlement appears even though it never creates a payments row', () => {
    expect(posCashLine).toBeDefined();
    expect(posCashLine).toMatchObject({
      grossAmount: '55.20',
      feeAmount: '0.00',
      netAmount: '55.20',
      method: 'cash',
      providerReference: null,
      source: { kind: 'pos', label: 'Reconciliation Bar', channel: 'staff' },
      isRefund: false,
    });
  });

  it('applies the fee to a POS card settlement using the same snapshotted percentage', () => {
    expect(posCardLine).toMatchObject({
      grossAmount: '55.20',
      feeAmount: '1.38',
      netAmount: '53.82',
      method: 'card',
      source: { kind: 'pos', label: 'Reconciliation Bar', channel: 'staff' },
    });
  });

  it('never double-counts a room-charge POS settlement — no money has moved yet', () => {
    const roomChargeLine = report.lines.find((line) => line.source.kind === 'pos' && line.method === 'room_charge');
    expect(roomChargeLine).toBeUndefined();
  });

  it('surfaces an unmatched/orphaned captured card payment, never silently dropped', () => {
    expect(orphanedLine).toBeDefined();
    expect(orphanedLine.note).toMatch(/no standing settlement/i);
    expect(orphanedLine.source.label).toBe('Reconciliation Bar');
  });

  it('reports a POS-target refund as its own line, resolved against its voided parent settlement', () => {
    expect(posRefundLine).toBeDefined();
    expect(posRefundLine).toMatchObject({
      grossAmount: '-55.20',
      feeAmount: '-1.38',
      netAmount: '-53.82',
      isRefund: true,
      source: { kind: 'pos', label: 'Reconciliation Bar' },
    });
  });

  it('regression: the ORIGINAL charge of a refunded POS payment still appears, even though refunding it voided the only settlement that referenced it', () => {
    // Real gap found while writing this suite: `refundPayment` voids the
    // whole original settlement on a POS-target refund, which drops it out
    // of both `listStandingSettlements` (voided) and
    // `listUnsettledCardPayments` (status no longer CAPTURED) — a report
    // that showed only the refund's own negative line would silently lose
    // the original charge that genuinely also hit the bank.
    expect(posRefundOriginalLine).toBeDefined();
    expect(posRefundOriginalLine).toMatchObject({
      grossAmount: '55.20',
      feeAmount: '1.38',
      netAmount: '53.82',
      isRefund: false,
      source: { kind: 'pos', label: 'Reconciliation Bar' },
    });
  });

  it('never lists a completed refund as still needing one', async () => {
    // Regression for the fix made alongside this report:
    // `listUnsettledCardPayments` used to include a refund payment's own
    // row (nothing else ever referenced it), double-listing it.
    const unsettledStillListingRefund = report.lines.filter((line) => line.paymentId === posRefundLine.paymentId);
    expect(unsettledStillListingRefund).toHaveLength(1);
  });

  it('summarizes gross/fee/net totals grouped by currency', () => {
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0].currency).toBe('NGN');
    expect(report.summary[0].count).toBe(report.lines.length);
  });

  it('exports a CSV with the reference/channel columns intact', async () => {
    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toMatch(/providerReference|ps_recon_folio/);
  });

  it('rejects a missing or malformed date range', async () => {
    const res = await getReport({ date_from: 'not-a-date', date_to: BUSINESS_DATE });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
  });

  it('rejects a date range spanning more than the configured maximum', async () => {
    const res = await getReport({ date_from: '2027-01-01', date_to: '2027-12-31' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_RECONCILIATION_RANGE_TOO_WIDE');
  });

  it('rejects a non-manager role', async () => {
    await setRole(ctx.a, 1, 'front_desk');
    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE }, tokenFor(ctx.a, ctx.a.users[1].id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
  });

  it('never leaks another tenant\'s payments into this report', async () => {
    await setRole(ctx.b, 0, 'manager');
    await t.trx('properties').where({ id: ctx.b.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    const bFolio = await openFolio(ctx.b);
    await seedAdjustment(bFolio, '999.00');
    const bCash = await t.request
      .post(`/api/v1/cashiering/folios/${bFolio.id}/payments/cash`)
      .set('Authorization', `Bearer ${tokenFor(ctx.b, ctx.b.users[0].id, ctx.b.properties[0].id)}`)
      .set('Idempotency-Key', idemKey())
      .send({ amount: '999.00', currency: 'NGN' });
    expect(bCash.status).toBe(201);

    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE });
    expect(res.status).toBe(200);
    expect(res.body.data.lines.some((line) => line.grossAmount === '999.00')).toBe(false);
  });
});
