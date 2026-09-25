'use strict';

/**
 * The billing gateway's read timeout and error tagging — the same behaviour
 * as the guest-payment adapter (see `tests/cashiering/paystack-adapter.test.js`),
 * with one billing-specific rule: WRITES are never timed out, because
 * `processTenantBillingCycle` treats any thrown gateway error as a definitive
 * failed charge (and sends a dunning email), so aborting a slow-but-successful
 * `charge_authorization` would record a paid subscription as failed.
 */

const gateway = require('../../src/modules/billing/paystack-gateway');
const { interpretGatewayError } = require('../../src/shared/gateway-record');

describe('billing paystack-gateway: bounded reads, unbounded writes', () => {
  const realFetch = global.fetch;
  const realKey = process.env.BILLING_PAYSTACK_SECRET_KEY;

  beforeEach(() => {
    process.env.BILLING_PAYSTACK_SECRET_KEY = 'sk_test_billing_timeouts';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.PAYSTACK_READ_TIMEOUT_MS;
    if (realKey === undefined) delete process.env.BILLING_PAYSTACK_SECRET_KEY;
    else process.env.BILLING_PAYSTACK_SECRET_KEY = realKey;
  });

  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ status: true, data }) });

  it('bounds the verify GET but never the charge_authorization POST', async () => {
    const signals = {};
    global.fetch = jest.fn(async (url, options) => {
      signals[options.method] = options.signal;
      return ok({ status: 'success', id: 1, reference: 'r', amount: 100, currency: 'NGN', authorization: {} });
    });

    await gateway.verifyTransaction({ reference: 'r' });
    await gateway.chargeAuthorization({ email: 'a@b.co', amount: '1.00', currency: 'NGN', authorizationCode: 'AUTH_x', reference: 'r2' });

    expect(signals.GET).toBeInstanceOf(AbortSignal);
    expect(signals.POST).toBeUndefined();
  });

  it('surfaces the requested amount alongside the collected one', async () => {
    global.fetch = jest.fn(async () => ok({ status: 'success', id: 9, reference: 'r', amount: 5030000, requested_amount: 5000000, currency: 'NGN', authorization: {} }));
    expect(await gateway.verifyTransaction({ reference: 'r' })).toMatchObject({ amountSubunit: 5030000, requestedAmountSubunit: 5000000 });
  });

  it('turns a timed-out verify into a transient GatewayRequestError', async () => {
    process.env.PAYSTACK_READ_TIMEOUT_MS = '20';
    global.fetch = jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }));
    const error = await gateway.verifyTransaction({ reference: 'r' }).catch((e) => e);
    expect(error).toBeInstanceOf(gateway.GatewayRequestError);
    expect(error.details).toEqual({ timedOut: true });
    expect(interpretGatewayError(error)).toBe('transient');
  });

  it('reads a 404 as no-such-transaction and a network failure as transient', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({ status: false, message: 'Transaction reference not found' }) }));
    expect(interpretGatewayError(await gateway.verifyTransaction({ reference: 'r' }).catch((e) => e))).toBe('record_not_found');

    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await gateway.verifyTransaction({ reference: 'r' }).catch((e) => e);
    expect(error.details).toEqual({ network: true });
    expect(interpretGatewayError(error)).toBe('transient');
  });
});
