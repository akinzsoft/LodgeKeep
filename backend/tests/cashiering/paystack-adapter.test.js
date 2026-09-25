'use strict';

/**
 * `src/modules/cashiering/paystack-adapter.js` — PLAN.md Phase 2.5's real
 * Paystack sandbox integration, and its gap-closure rebuild into a
 * multi-currency-capable factory (`buildAdapter(secretKey)` +
 * `resolveAdapterForCurrency`) once guest card payments stopped settling
 * into one shared platform account.
 *
 * `buildAdapter`'s `verifyWebhookSignature` is pure crypto (HMAC-SHA512)
 * and is tested here directly against a known secret/body/signature triple
 * — no network. The other adapter functions make REAL calls to
 * `https://api.paystack.co`; those tests are gated on `PAYSTACK_SECRET_KEY`
 * actually being configured in this environment (`.env`) and are skipped,
 * not failed, when it is absent — this codebase's environment does not
 * always carry sandbox credentials (CI, a contributor's own machine), and
 * a missing-credential skip is meaningfully different from a real
 * regression. See `service.js`'s tests (`tests/cashiering/cashiering.test.js`)
 * for the deterministic, mocked-adapter coverage of the payment state
 * machine itself, and `tests/setup/payment-subaccount.test.js` for
 * `resolveAdapterForCurrency`'s real database resolution.
 */

const crypto = require('crypto');
const { buildAdapter, GatewayNotConfiguredError } = require('../../src/modules/cashiering/paystack-adapter');

describe('paystack-adapter: buildAdapter throws without a secret key', () => {
  it('throws GatewayNotConfiguredError immediately, rather than deferring to the first call', () => {
    expect(() => buildAdapter(undefined)).toThrow(GatewayNotConfiguredError);
    expect(() => buildAdapter('')).toThrow(GatewayNotConfiguredError);
  });
});

describe('paystack-adapter: verifyWebhookSignature (pure crypto, no network)', () => {
  const secretKey = 'sk_test_fixture_secret_for_signature_tests';
  const adapter = buildAdapter(secretKey);

  it('accepts a signature that is the real HMAC-SHA512 of the raw body under the secret key', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: signature })).toBe(true);
  });

  it('rejects a signature computed under the wrong secret', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const wrongSignature = crypto.createHmac('sha512', 'not-the-real-secret').update(rawBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: wrongSignature })).toBe(false);
  });

  it('rejects a signature computed over a DIFFERENT body than the one supplied (the exact tamper case API.md §7 exists to catch)', () => {
    const originalBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1', amount: 10000 } }));
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1', amount: 999999 } }));
    const signatureForOriginal = crypto.createHmac('sha512', secretKey).update(originalBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody: tamperedBody, signatureHeader: signatureForOriginal })).toBe(false);
  });

  it('rejects a missing signature header outright', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success' }));
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: undefined })).toBe(false);
  });

  it('two adapters built from two DIFFERENT secrets disagree on the same signature — the exact property multi-currency verification depends on', () => {
    const otherAdapter = buildAdapter('sk_test_a_completely_different_secret');
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: signature })).toBe(true);
    expect(otherAdapter.verifyWebhookSignature({ rawBody, signatureHeader: signature })).toBe(false);
  });
});

describe('paystack-adapter: real sandbox calls', () => {
  const hasRealCredentials = Boolean(process.env.PAYSTACK_SECRET_KEY);
  const maybeIt = hasRealCredentials ? it : it.skip;

  if (!hasRealCredentials) {
    it('is skipped: no PAYSTACK_SECRET_KEY configured in this environment', () => {
      expect(hasRealCredentials).toBe(false);
    });
  }

  maybeIt('initializes a real transaction against the Paystack sandbox and gets back a usable authorization_url', async () => {
    const adapter = buildAdapter(process.env.PAYSTACK_SECRET_KEY);
    const reference = `lodgekeep-test-${Date.now()}`;
    const result = await adapter.initializeTransaction({
      email: 'lodgekeep-test@example.com',
      amount: '100.00',
      currency: 'NGN',
      reference,
    });
    expect(result.authorizationUrl).toMatch(/^https:\/\//);
    expect(result.reference).toBe(reference);
  });

  maybeIt('verifying a reference that was never charged reports a non-success status, not an error', async () => {
    const adapter = buildAdapter(process.env.PAYSTACK_SECRET_KEY);
    const reference = `lodgekeep-test-unpaid-${Date.now()}`;
    await adapter.initializeTransaction({ email: 'lodgekeep-test@example.com', amount: '50.00', currency: 'NGN', reference });

    const result = await adapter.verifyTransaction({ reference });
    expect(result.status).not.toBe('success');
    expect(result.reference).toBe(reference);
  });
});

describe('paystack-adapter: reads are bounded and errors are classifiable (webhook verification)', () => {
  const { GatewayRequestError } = require('../../src/modules/cashiering/paystack-adapter');
  const { interpretGatewayError } = require('../../src/shared/gateway-record');
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.PAYSTACK_READ_TIMEOUT_MS;
  });

  function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it('gives Verify Transaction a timeout signal, and neither a POST nor another GET', async () => {
    const signals = {};
    global.fetch = jest.fn(async (url, options) => {
      signals[options.method] = options.signal;
      return jsonResponse(200, { status: true, data: { status: 'success', id: 1, reference: 'r', amount: 100, currency: 'NGN' } });
    });
    const adapter = buildAdapter('sk_test_x');

    await adapter.verifyTransaction({ reference: 'r' });
    await adapter.initializeTransaction({ email: 'a@b.co', amount: '1.00', currency: 'NGN', reference: 'r2' });
    expect(signals.GET).toBeInstanceOf(AbortSignal);
    expect(signals.POST).toBeUndefined();

    // Bank resolution is a slow GET that is deliberately not bounded.
    global.fetch = jest.fn(async (url, options) => {
      signals.bank = options.signal;
      return jsonResponse(200, { status: true, data: { account_number: '0000000000', account_name: 'X' } });
    });
    await adapter.resolveBankAccount({ accountNumber: '0000000000', bankCode: '058' });
    expect(signals.bank).toBeUndefined();
  });

  it('surfaces the requested amount alongside the collected one', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(200, { status: true, data: { status: 'success', id: 9, reference: 'r', amount: 2030, requested_amount: 2000, currency: 'NGN', channel: 'card' } })
    );
    const result = await buildAdapter('sk_test_x').verifyTransaction({ reference: 'r' });
    expect(result).toMatchObject({ amountSubunit: 2030, requestedAmountSubunit: 2000, currency: 'NGN', channel: 'card' });
  });

  it('turns a timed-out read into a GatewayRequestError tagged timedOut, read as transient', async () => {
    process.env.PAYSTACK_READ_TIMEOUT_MS = '20';
    global.fetch = jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }));

    const error = await buildAdapter('sk_test_x').verifyTransaction({ reference: 'r' }).catch((e) => e);

    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error.details).toEqual({ timedOut: true });
    expect(interpretGatewayError(error)).toBe('transient');
  });

  it('tags a network failure and reads it as transient', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await buildAdapter('sk_test_x').verifyTransaction({ reference: 'r' }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error.details).toEqual({ network: true });
    expect(interpretGatewayError(error)).toBe('transient');
  });

  it('reads the live sandbox unknown-reference response (400 + transaction_not_found) as "no such transaction"', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(400, {
        status: false,
        message: 'Transaction reference not found.',
        meta: { nextStep: "Ensure that you're passing the reference of a transaction that exists on this integration" },
        type: 'validation_error',
        code: 'transaction_not_found',
      })
    );
    const error = await buildAdapter('sk_test_x').verifyTransaction({ reference: 'nope' }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(interpretGatewayError(error)).toBe('record_not_found');
  });

  it('reads Paystack’s 404 as "no such transaction", and 401/429/5xx as transient', async () => {
    const adapter = buildAdapter('sk_test_x');
    const outcomes = {};
    for (const status of [404, 401, 429, 500]) {
      global.fetch = jest.fn(async () => jsonResponse(status, { status: false, message: `HTTP ${status}` }));
      const error = await adapter.verifyTransaction({ reference: 'r' }).catch((e) => e);
      outcomes[status] = interpretGatewayError(error);
    }
    expect(outcomes).toEqual({ 404: 'record_not_found', 401: 'transient', 429: 'transient', 500: 'transient' });
  });
});
