import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchDeployedBuildId } from '../version.js';

describe('fetchDeployedBuildId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the deployed build id without any cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ buildId: 'build-9' }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchDeployedBuildId()).toBe('build-9');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^\/version\.json\?t=\d+$/);
    expect(options).toMatchObject({ cache: 'no-store' });
  });

  it('answers null — never throws — for a missing file, bad JSON, or no network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchDeployedBuildId()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad json')) }));
    expect(await fetchDeployedBuildId()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await fetchDeployedBuildId()).toBeNull();
  });
});
