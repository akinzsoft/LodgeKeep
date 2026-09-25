'use strict';

/**
 * The browser / manual confirmation path (`POST /cashiering/payments/:id/verify`,
 * and through it the portal, QR and POS confirmations) now applies the same
 * check the webhook does: Paystack's own record must agree with the LOCAL
 * payment on reference, amount and currency before anything is applied.
 * Previously it asked Paystack for the record and then ignored its amount and
 * currency entirely.
 *
 * Only a DISAGREEMENT is new. How a status that is not yet final is treated is
 * deliberately unchanged (the portal abandons a booking on FAILED), and a
 * matching success still captures — both pinned below so this gate cannot
 * silently change either.
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
const { gatewayRecordFor } = require('../helpers/gateway-record');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

describe('verifyPayment — the confirmation path checks Paystack’s record against the local payment', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-01-10' });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paystack.verifyTransaction.mockReset();
  });

  const token = () =>
    signAccessToken({ aud: 'staff', sub: String(ctx.a.users[0].id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });

  async function pendingPayment(amount = '20.00') {
    counter += 1;
    const [folioId] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      reservation_id: ctx.a.reservations[0].id,
      folio_number: `VG${String(counter).padStart(6, '0')}`,
      status: 'open',
      balance: amount,
      currency: 'NGN',
      billed_to: 'Guest',
    });
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/x', accessCode: 'x', reference }));
    const res = await t.request
      .post(`/api/v1/cashiering/folios/${folioId}/payments/paystack`)
      .set('Authorization', `Bearer ${token()}`)
      .set('Idempotency-Key', `vg-key-${counter}`)
      .send({ amount, currency: 'NGN', guest_email: 'guest@example.com' });
    expect(res.status).toBe(201);
    return t.trx('payments').where({ id: res.body.data.id }).first();
  }

  function verify(payment) {
    return t.request
      .post(`/api/v1/cashiering/payments/${payment.id}/verify`)
      .set('Authorization', `Bearer ${token()}`)
      .set('Idempotency-Key', `vg-verify-${payment.id}-${++counter}`)
      .send({});
  }

  it.each([
    ['a lower amount', { amountSubunit: 1 }, 'AMOUNT_MISMATCH'],
    ['a different currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ['a different reference', { reference: 'someone-elses-ref' }, 'REFERENCE_MISMATCH'],
    ['no amount', { amountSubunit: undefined }, 'AMOUNT_MISSING'],
  ])('refuses %s with a 422, applies nothing, and audits it', async (_label, override, code) => {
    const payment = await pendingPayment();
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, override));

    const res = await verify(payment);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_RECORD_MISMATCH');
    expect(res.body.error.details.reasons.map((r) => r.code)).toEqual([code]);

    const after = await t.trx('payments').where({ id: payment.id }).first();
    expect(after.status).toBe(payment.status); // untouched — neither captured nor failed
    expect(await t.trx('folio_line_items').where({ payment_id: payment.id })).toHaveLength(0);
    const audit = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: String(payment.id), action: 'gateway_verification_rejected' }).first();
    expect(audit).toBeTruthy();
  });

  it('still captures a record that matches', async () => {
    const payment = await pendingPayment('35.00');
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
    const res = await verify(payment);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CAPTURED');
  });

  it('accepts a customer-borne fee only when the requested amount matches', async () => {
    const payment = await pendingPayment('20.00');
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { amountSubunit: 2030, requestedAmountSubunit: 2000 }));
    expect((await verify(payment)).status).toBe(200);
  });

  it('leaves the existing treatment of a not-yet-final status unchanged (it still fails a folio payment)', async () => {
    const payment = await pendingPayment();
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { status: 'abandoned' }));
    const res = await verify(payment);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FAILED'); // deliberately not changed here: portal/QR flows key off it
  });

  it('does not treat a failed record with a different amount as a mismatch', async () => {
    const payment = await pendingPayment();
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { status: 'failed', amountSubunit: 0 }));
    const res = await verify(payment);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FAILED');
  });
});
