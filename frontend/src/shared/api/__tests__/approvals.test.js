import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetApiClientForTesting } from '../client.js';
import { approvalHeaders, requestApproval } from '../approvals.js';
import { voidSettlement, addItem, settleOrder } from '../pos.js';
import { voidSale, createSale, refundOnlineSale, startOnlineSale } from '../supermarket.js';
import { refundPayment } from '../cashiering.js';

const ok = (data) => ({ status: 200, json: async () => ({ data, meta: {}, error: null }) });

/**
 * A manager's approval token travels in the `X-Manager-Approval` header,
 * never the body: the server's idempotency check hashes the body, and a body
 * that changed with every fresh approval would turn a safe retry into a
 * "key reused with different parameters" refusal.
 */
describe('manager approval token on the wire', () => {
  beforeEach(() => {
    _resetApiClientForTesting();
    vi.stubGlobal('fetch', vi.fn(async () => ok({})));
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'uuid-1' });
  });
  afterEach(() => vi.unstubAllGlobals());

  const sent = () => {
    const [, init] = fetch.mock.calls.at(-1);
    return { headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
  };

  it('builds the header only when there is a token', () => {
    expect(approvalHeaders('tok')).toEqual({ 'X-Manager-Approval': 'tok' });
    expect(approvalHeaders(null)).toEqual({});
  });

  it.each([
    ['POS settlement void', () => voidSettlement('1', '2', 'Keyed in error', 'tok')],
    ['POS add item past stock', () => addItem('1', { menuItemId: '3', quantity: 1, stockOverrideReason: 'Crate in the back', approval: 'tok' })],
    ['POS settle past stock', () => settleOrder('1', [{ method: 'cash' }], { stockOverrideReason: 'Crate', approval: 'tok' })],
    ['supermarket void', () => voidSale('9', 'Wrong item', 'tok')],
    ['supermarket oversell', () => createSale({ outletId: '5', items: [], method: 'cash', confirmOversell: true, approval: 'tok' })],
    ['supermarket online oversell', () => startOnlineSale({ outletId: '5', items: [], confirmOversell: true, approval: 'tok' })],
    ['supermarket needs-review refund', () => refundOnlineSale('44', 'Paid after cancel', 'tok')],
    ['POS card refund', () => refundPayment('70', { reason: 'Paid twice', approval: 'tok' })],
  ])('%s: header, not body', async (_label, call) => {
    await call();
    const { headers, body } = sent();
    expect(headers['X-Manager-Approval']).toBe('tok');
    expect(JSON.stringify(body ?? {})).not.toContain('tok');
  });

  it('sends no approval header when there is none (a plain refund of a folio payment)', async () => {
    await refundPayment('70', { reason: 'Folio refund' });
    expect(sent().headers).not.toHaveProperty('X-Manager-Approval');
  });

  it('asks for an approval with the manager, PIN, reason and record', async () => {
    await requestApproval({ action: 'pos.void_settlement', approverUserId: '7', pin: '482915', reason: 'Twice', targetId: '55' });
    const [url, init] = fetch.mock.calls.at(-1);
    expect(url).toMatch(/\/approvals$/);
    expect(JSON.parse(init.body)).toEqual({ action: 'pos.void_settlement', approver_user_id: '7', pin: '482915', reason: 'Twice', target_id: '55' });
  });
});
