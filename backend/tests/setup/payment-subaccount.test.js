'use strict';

/**
 * Gap closure: guest card payments no longer settle into one shared
 * platform Paystack account (research + user-confirmed architecture:
 * Paystack Subaccounts under our own single merchant integration).
 * Covers `GET/POST/PUT /api/v1/payment-subaccount*` — the Setup screen's
 * "bank account number + bank name, which creates the Paystack subaccount
 * via our integration" flow — RBAC (setup.view/setup.manage, matching
 * every other Setup screen), and the real, unmocked
 * `GatewayNotConfiguredError` path for a property whose own
 * `base_currency` has no configured `platform_payment_integrations` row.
 *
 * `resolveAdapterForCurrency` is mocked to behave EXACTLY like the real
 * function for the one currency this test environment always has a real
 * row for (NGN, seeded by `tests/helpers/fixtures.js` regardless of
 * whether a real `PAYSTACK_SECRET_KEY` was present at migration time) —
 * genuinely resolving, then handing back a controllable mock adapter so
 * `resolveBankAccount`/`createSubaccount` never touch the real network —
 * while a currency it does NOT recognise (GBP, `properties[1]`'s own real
 * fixture currency, deliberately unconfigured) genuinely throws the real
 * `GatewayNotConfiguredError`, exercising that path for real rather than
 * asserting it in the abstract.
 *
 * The mocked `integration.id` is NOT a hardcoded literal — it is set from
 * `seedTwoTenants`'s own real `platformPaymentIntegrations.ngn` return
 * value once `beforeAll` resolves it (see below). A hardcoded `id: 1`
 * only happens to be correct when the migration itself already seeded a
 * permanent row (real `PAYSTACK_SECRET_KEY` present at migration time,
 * e.g. this project's own local dev environment) — in any environment
 * without one (CI, a fresh contributor checkout), `platform_payment_
 * integrations` starts empty and `fixtures.js`'s own insert-if-missing
 * row is created (and, since it lives inside this file's own rolled-back
 * per-file transaction, re-created) fresh by whichever test file happens
 * to seed it, landing on whatever the real, currently-incrementing
 * AUTO_INCREMENT value is — never reliably `1`. A hardcoded `1` genuinely
 * passed in this project's own dev environment while genuinely 500ing on
 * a real, unrelated `platform_payment_integration_id` foreign-key
 * violation in a fresh one, reproduced and root-caused directly against a
 * CI-faithful fresh checkout before this fix.
 *
 * Deliberately uses `properties[0]` (NGN) for the happy-path tests —
 * `fixtures.js` seeds a real `property_payment_subaccounts` row there for
 * both tenants (the generic `ISO-*` isolation suite's own "every table
 * already has interleaved rows" assumption), so `GET` returning that real
 * row, and `PUT` REPLACING it, are both genuinely exercised. `properties[1]`
 * (GBP, no fixture subaccount) is used for the "no integration configured"
 * case.
 *
 * Cross-tenant isolation for `property_payment_subaccounts` is covered
 * separately by the generic `ISO-*` suite (`tests/helpers/entities.js`'s
 * new entry) — not repeated here.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    resolveBankAccount: jest.fn(),
    createSubaccount: jest.fn(),
  };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    // No default implementation here — see beforeAll below for why the
    // real (dynamic) NGN integration id can't be known at factory time.
    resolveAdapterForCurrency: jest.fn(),
  };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystackMock = paystackAdapterModule.__mockAdapter;
const { GatewayNotConfiguredError } = jest.requireActual('../../src/modules/cashiering/paystack-adapter');

describe('Payment subaccount (gap closure: no shared platform Paystack account for guest payments)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    // The real integration id, not a hardcoded literal — see this file's
    // own header for why `1` only happens to be right in some environments.
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async (db, currency) => {
      if (currency !== 'NGN') throw new GatewayNotConfiguredError('paystack');
      return { integration: { id: ctx.platformPaymentIntegrations.ngn, currency: 'NGN' }, adapter: paystackMock };
    });
  });

  function tokenFor({ tenant, userIndex = 0, propertyId }) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[userIndex].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, propertyIndex, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  async function adminToken({ propertyIndex = 0 } = {}) {
    await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex, role: 'admin' });
    return tokenFor({ tenant: ctx.a, userIndex: 1, propertyId: ctx.a.properties[propertyIndex].id });
  }

  beforeEach(() => {
    paystackMock.resolveBankAccount.mockReset();
    paystackMock.createSubaccount.mockReset();
  });

  describe('GET /api/v1/payment-subaccount', () => {
    it('returns the real fixture-seeded subaccount for the active property', async () => {
      const res = await t.request.get('/api/v1/payment-subaccount').set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`);
      expect(res.status).toBe(200);
      expect(res.body.data.subaccount_code).toBe(`ACCT_fixture_${ctx.a.slug}`);
      expect(res.body.data.account_number_last4).toBe('1784');
      // The full account number is never returned — only the last 4, and
      // no `account_number` field exists on the row at all (never stored,
      // per the migration's own header).
      expect(res.body.data).not.toHaveProperty('account_number');
    });

    it('a manager (the fixture-seeded default, setup.view) can read', async () => {
      const res = await t.request.get('/api/v1/payment-subaccount').set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`);
      expect(res.status).toBe(200);
    });

    it('a role without setup.view is refused', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'front_desk' });
      const res = await t.request
        .get('/api/v1/payment-subaccount')
        .set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a, userIndex: 1 })}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });
  });

  describe('POST /api/v1/payment-subaccount/resolve-bank-account', () => {
    it('setup.manage resolves a real bank account name via the (mocked) gateway', async () => {
      paystackMock.resolveBankAccount.mockResolvedValueOnce({ accountName: 'JANE DOE' });
      const res = await t.request
        .post('/api/v1/payment-subaccount/resolve-bank-account')
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send({ bank_code: '057', account_number: '0123456789' });
      expect(res.status).toBe(200);
      expect(res.body.data.accountName).toBe('JANE DOE');
      expect(paystackMock.resolveBankAccount).toHaveBeenCalledWith({ bankCode: '057', accountNumber: '0123456789' });
    });

    it('rejects a missing bank_code/account_number with a friendly 400, never reaching the gateway', async () => {
      const res = await t.request
        .post('/api/v1/payment-subaccount/resolve-bank-account')
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
      expect(paystackMock.resolveBankAccount).not.toHaveBeenCalled();
    });

    it('setup.view alone (manager) is refused — this is a setup.manage action', async () => {
      const res = await t.request
        .post('/api/v1/payment-subaccount/resolve-bank-account')
        .set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`)
        .send({ bank_code: '057', account_number: '0123456789' });
      expect(res.status).toBe(403);
    });

    it('a property whose base_currency has no configured integration gets a real, unmocked GatewayNotConfiguredError (501)', async () => {
      const res = await t.request
        .post('/api/v1/payment-subaccount/resolve-bank-account')
        .set('Authorization', `Bearer ${await adminToken({ propertyIndex: 1 })}`)
        .send({ bank_code: '057', account_number: '0123456789' });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('PAYMENT_GATEWAY_NOT_CONFIGURED');
      expect(paystackMock.resolveBankAccount).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/v1/payment-subaccount', () => {
    it('creates a real Paystack Subaccount (mocked gateway) and stores only the last 4 of the account number', async () => {
      paystackMock.createSubaccount.mockResolvedValueOnce({
        subaccountCode: 'ACCT_new_test_code',
        accountName: 'ALPHA HOTELS LTD',
        bankName: 'Zenith Bank',
      });

      const res = await t.request
        .put('/api/v1/payment-subaccount')
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send({ bank_code: '057', bank_name: 'Zenith Bank', account_number: '9988776655' });

      expect(res.status).toBe(200);
      expect(res.body.data.subaccount_code).toBe('ACCT_new_test_code');
      expect(res.body.data.account_name).toBe('ALPHA HOTELS LTD');
      expect(res.body.data.account_number_last4).toBe('6655');
      expect(res.body.data.percentage_charge).toBe('0.00');

      expect(paystackMock.createSubaccount).toHaveBeenCalledWith(
        expect.objectContaining({ bankCode: '057', accountNumber: '9988776655', percentageCharge: 0 })
      );

      // Replaces the existing singleton row (UNIQUE(tenant_id, property_id))
      // rather than a second row — this property already had a fixture
      // subaccount before this call.
      const rows = await t.trx('property_payment_subaccounts').where({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id });
      expect(rows).toHaveLength(1);
      expect(rows[0].subaccount_code).toBe('ACCT_new_test_code');
    });

    it('rejects a missing bank_name with a friendly 400', async () => {
      const res = await t.request
        .put('/api/v1/payment-subaccount')
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send({ bank_code: '057', account_number: '9988776655' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
      expect(paystackMock.createSubaccount).not.toHaveBeenCalled();
    });

    it('setup.view alone (manager) is refused', async () => {
      const res = await t.request
        .put('/api/v1/payment-subaccount')
        .set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`)
        .send({ bank_code: '057', bank_name: 'Zenith Bank', account_number: '9988776655' });
      expect(res.status).toBe(403);
      expect(paystackMock.createSubaccount).not.toHaveBeenCalled();
    });

    it('a property whose base_currency has no configured integration gets a real, unmocked GatewayNotConfiguredError (501), and writes nothing', async () => {
      const res = await t.request
        .put('/api/v1/payment-subaccount')
        .set('Authorization', `Bearer ${await adminToken({ propertyIndex: 1 })}`)
        .send({ bank_code: '057', bank_name: 'Some Bank', account_number: '9988776655' });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('PAYMENT_GATEWAY_NOT_CONFIGURED');
      const rows = await t.trx('property_payment_subaccounts').where({ tenant_id: ctx.a.id, property_id: ctx.a.properties[1].id });
      expect(rows).toHaveLength(0);
    });
  });
});
