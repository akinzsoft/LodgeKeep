import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runNightAudit } from '../night-audit.js';
import { _resetApiClientForTesting } from '../client.js';

function mockResponse(status, envelope) {
  return {
    status,
    json: async () => envelope,
  };
}

const ok = (data, meta = {}) => ({ data, meta, error: null });

/**
 * Gap closure (user-reported): running night audit blanked the whole page.
 * `NightAuditScreen.jsx` reads BOTH `lastResult.data.*` and
 * `lastResult.meta.*` from what `runNightAudit()` resolves to — but the
 * wrapper used plain `request()`, which silently discards the envelope's
 * `meta`, so `lastResult.meta` was `undefined` and the very next render
 * threw reading `.nextBusinessDate` off it, crashing the tree (no error
 * boundary catches it). `NightAuditScreen.test.jsx`'s own existing test
 * never caught this because it mocks `nightAuditApi.runNightAudit`
 * directly, bypassing the real `client.js` request/response boundary this
 * bug actually lived in — this test exercises that real boundary instead,
 * the same way `client.test.jsx` proves `requestWithMeta`'s own contract.
 */
describe('runNightAudit()', () => {
  beforeEach(() => {
    _resetApiClientForTesting();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves both data and meta from the real envelope, not just data', async () => {
    fetch.mockResolvedValueOnce(
      mockResponse(
        200,
        ok(
          { business_date: '2027-01-01', room_revenue: '500.00', occupancy_pct: '75.00' },
          { nextBusinessDate: '2027-01-02', exceptions: [] }
        )
      )
    );

    const result = await runNightAudit();

    expect(result.data.business_date).toBe('2027-01-01');
    expect(result.meta.nextBusinessDate).toBe('2027-01-02');
    expect(result.meta.exceptions).toEqual([]);
  });
});
