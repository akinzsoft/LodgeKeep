import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request, requestWithMeta, configureApiClient, _resetApiClientForTesting } from '../client.js';
import { ApiError } from '../ApiError.js';

function mockResponse(status, envelope) {
  return {
    status,
    json: async () => envelope,
  };
}

const ok = (data) => ({ data, meta: {}, error: null });
const fail = (code, message = 'failed', details = null, requestId = 'req_1') => ({
  data: null,
  meta: {},
  error: { code, message, details, request_id: requestId },
});

describe('request()', () => {
  beforeEach(() => {
    _resetApiClientForTesting();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps data on a successful envelope', async () => {
    fetch.mockResolvedValueOnce(mockResponse(200, ok({ hello: 'world' })));
    const data = await request('/whatever', { auth: false });
    expect(data).toEqual({ hello: 'world' });
  });

  it('throws an ApiError carrying the backend error shape plus the HTTP status', async () => {
    fetch.mockResolvedValueOnce(mockResponse(401, fail('AUTH_INVALID_CREDENTIALS', 'nope')));
    await expect(request('/auth/login', { auth: false })).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'nope',
      status: 401,
    });
  });

  it('attaches the current access token when auth is not opted out (the default)', async () => {
    configureApiClient({ accessTokenGetter: () => 'the-token', accessTokenExpiredHandler: null });
    fetch.mockResolvedValueOnce(mockResponse(200, ok({})));
    await request('/reservations');
    const [, init] = fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer the-token');
  });

  it('attaches no Authorization header for an endpoint that opts out (login, refresh, ...)', async () => {
    configureApiClient({ accessTokenGetter: () => 'the-token', accessTokenExpiredHandler: null });
    fetch.mockResolvedValueOnce(mockResponse(200, ok({})));
    await request('/auth/login', { auth: false });
    const [, init] = fetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('wraps a genuine network failure (fetch throwing) into ApiError NETWORK_ERROR, never silently swallowed', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(request('/whatever', { auth: false })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('refreshes once and retries on AUTH_TOKEN_EXPIRED, then succeeds', async () => {
    let currentToken = 'expired-token';
    configureApiClient({
      accessTokenGetter: () => currentToken,
      accessTokenExpiredHandler: async () => {
        currentToken = 'fresh-token';
        return currentToken;
      },
    });

    fetch
      .mockResolvedValueOnce(mockResponse(401, fail('AUTH_TOKEN_EXPIRED', 'expired')))
      .mockResolvedValueOnce(mockResponse(200, ok({ ok: true })));

    const data = await request('/reservations');
    expect(data).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetch.mock.calls[1];
    expect(secondInit.headers.Authorization).toBe('Bearer fresh-token');
  });

  it('does not attempt a refresh for a 401 that is not AUTH_TOKEN_EXPIRED', async () => {
    const expiredHandler = vi.fn();
    configureApiClient({ accessTokenGetter: () => 'a-token', accessTokenExpiredHandler: expiredHandler });
    fetch.mockResolvedValueOnce(mockResponse(401, fail('AUTH_SESSION_INVALID', 'deactivated')));

    await expect(request('/reservations')).rejects.toMatchObject({ code: 'AUTH_SESSION_INVALID' });
    expect(expiredHandler).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed refresh rather than retrying forever', async () => {
    configureApiClient({
      accessTokenGetter: () => 'expired-token',
      accessTokenExpiredHandler: async () => {
        throw new ApiError({ code: 'AUTH_TOKEN_INVALID', message: 'refresh token invalid' });
      },
    });
    fetch.mockResolvedValueOnce(mockResponse(401, fail('AUTH_TOKEN_EXPIRED', 'expired')));

    await expect(request('/reservations')).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('requestWithMeta()', () => {
  beforeEach(() => {
    _resetApiClientForTesting();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns both data and meta, unlike request()', async () => {
    fetch.mockResolvedValueOnce(mockResponse(201, { data: { id: '1' }, meta: { authorizationUrl: 'https://paystack.test/pay/abc' }, error: null }));
    const result = await requestWithMeta('/portal/bookings', { method: 'POST', auth: false });
    expect(result).toEqual({ data: { id: '1' }, meta: { authorizationUrl: 'https://paystack.test/pay/abc' } });
  });

  it('still refreshes once and retries on AUTH_TOKEN_EXPIRED, same as request()', async () => {
    configureApiClient({
      accessTokenGetter: () => 'expired-token',
      accessTokenExpiredHandler: async () => 'fresh-token',
    });
    fetch
      .mockResolvedValueOnce(mockResponse(401, fail('AUTH_TOKEN_EXPIRED', 'expired')))
      .mockResolvedValueOnce(mockResponse(200, ok({ id: '1' })));

    const result = await requestWithMeta('/portal/account/bookings');
    expect(result).toEqual({ data: { id: '1' }, meta: {} });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
