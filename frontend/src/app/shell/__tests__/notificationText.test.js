import { describe, it, expect } from 'vitest';
import { describeNotification, notificationIntent, notificationTarget, parsePayload, summarizeItems, timeAgo } from '../notificationText.js';

describe('describeNotification', () => {
  it('describes a new guest QR order with who, where, what, and the exact total', () => {
    const { title, detail } = describeNotification({
      type: 'qr_ordering.guest_order_placed',
      payload: JSON.stringify({
        tableLabel: 'Table 4',
        guestName: 'John',
        items: [
          { name: 'Chapman', quantity: 2 },
          { name: 'Coke', quantity: 1 },
        ],
        total: '6000.00',
        currency: 'NGN',
      }),
    });
    expect(title).toBe('New QR order — Table 4');
    expect(detail).toMatch(/^John: 2× Chapman, 1× Coke · .*6,000\.00$/);
  });

  it('names a departing guest, their room, and what they owe', () => {
    const { title, detail } = describeNotification({
      type: 'front_desk.departing_balance_outstanding',
      payload: { guestName: 'Ada Obi', roomNumber: '204', balance: '15000.00', currency: 'NGN' },
    });
    expect(title).toBe('Departing today with a balance — Ada Obi');
    expect(detail).toMatch(/^Room 204 · owes .*15,000\.00$/);
  });

  it('describes each step of a stock request — asked, sent (short or not), rejected', () => {
    expect(
      describeNotification({ type: 'stock.transfer_requested', payload: { requestId: 5, fromOutletName: 'Main Store', toOutletName: 'Main Bar', lineCount: 3 } }),
    ).toEqual({ title: 'Stock requested — Main Bar', detail: 'Request #5: 3 items from Main Store' });
    expect(
      describeNotification({ type: 'stock.transfer_requested', payload: { requestId: 9, fromOutletName: 'Main Store', toOutletName: 'Main Bar', lineCount: 1, topUpOfRequestId: 5 } }).detail,
    ).toBe('Request #9 (top-up of #5): 1 item from Main Store');
    expect(
      describeNotification({ type: 'stock.transfer_requested', payload: { requestId: 5, fromOutletName: 'Main Store', toOutletName: 'Main Bar', lineCount: 2, reminder: true } }),
    ).toEqual({ title: 'Still waiting — Main Bar', detail: 'Request #5: 2 items from Main Store' });
    expect(
      describeNotification({ type: 'stock.transfer_request_issued', payload: { requestId: 5, fromOutletName: 'Main Store', toOutletName: 'Main Bar', lineCount: 3, shortLineCount: 1 } }),
    ).toEqual({ title: 'Stock sent — Main Bar', detail: 'Request #5 from Main Store · 1 item sent short' });
    expect(
      describeNotification({ type: 'stock.transfer_request_issued', payload: { requestId: 6, fromOutletName: 'Main Store', toOutletName: 'Main Bar', lineCount: 1, shortLineCount: 0 } }).detail,
    ).toBe('Request #6 from Main Store');
    expect(
      describeNotification({ type: 'stock.transfer_request_rejected', payload: { requestId: 7, fromOutletName: 'Main Store', toOutletName: 'Main Bar', reason: 'Counting tonight' } }),
    ).toEqual({ title: 'Stock request rejected — Main Bar', detail: 'Request #7 · Counting tonight' });
    expect(notificationTarget('stock.transfer_requested')).toBe('pos');
  });

  it('shows stock quantities without trailing zeros', () => {
    const { title, detail } = describeNotification({
      type: 'stock.reorder_level_reached',
      payload: { name: 'Gin', unit: 'bottle', quantity: '2.500', reorderLevel: '5.000' },
    });
    expect(title).toBe('Low stock: Gin');
    expect(detail).toBe('2.5 bottle left, reorder level 5');
  });

  it('explains why a room became dirty', () => {
    expect(describeNotification({ type: 'room.became_dirty', payload: { roomNumber: '07', reason: 'room_move' } })).toEqual({
      title: 'Room 07 needs cleaning',
      detail: 'Vacated by a room move.',
    });
  });

  it('falls back to the raw type for an unknown notification', () => {
    expect(describeNotification({ type: 'something.new', payload: {} })).toEqual({ title: 'something.new', detail: '' });
  });

  it('states the day night audit closed and the new business date', () => {
    expect(
      describeNotification({ type: 'night_audit.completed', payload: { businessDate: '2027-02-01', nextBusinessDate: '2027-02-02' } })
    ).toEqual({ title: 'Night audit closed 2027-02-01', detail: 'Business date is now 2027-02-02.' });
  });

  it('names how many unresolved discrepancies are blocking night audit', () => {
    expect(
      describeNotification({ type: 'night_audit.failed', payload: { businessDate: '2027-02-15', reason: 'blocked_by_discrepancy', conditionCount: 1 } })
    ).toEqual({ title: 'Night audit blocked — 2027-02-15', detail: '1 unresolved housekeeping discrepancy is blocking it.' });
  });

  it('shows the real error message for a genuine night audit failure', () => {
    expect(
      describeNotification({ type: 'night_audit.failed', payload: { businessDate: '2027-02-15', reason: 'error', message: 'boom' } })
    ).toEqual({ title: 'Night audit failed — 2027-02-15', detail: 'boom' });
  });

  it('flags an overdue night audit with how stale the business date is', () => {
    expect(
      describeNotification({ type: 'night_audit.overdue', payload: { businessDate: '2027-02-15', todayInPropertyTz: '2027-02-16' } })
    ).toEqual({ title: 'Night audit overdue — 2027-02-15', detail: "It's already 2027-02-16 and that date is still open." });
  });

  it('a locked manager approval PIN names the manager and the till user', () => {
    expect(describeNotification({ type: 'approvals.pin_locked', payload: { approverName: 'Grace Manager', triedByName: 'Ada Bello', action: 'pos.void_settlement' } })).toEqual({
      title: 'Approval PIN locked — Grace Manager',
      detail: "Wrong PINs entered at Ada Bello's till · locked for 15 minutes",
    });
  });
});

describe('security notifications', () => {
  it('the verification-code-off alert names who and why, and opens Setup', () => {
    expect(describeNotification({ type: 'security.mfa_requirement_disabled', payload: { actorName: 'Ada Bello', reason: 'Mailbox down' } })).toEqual({
      title: 'Admin verification code switched off',
      detail: 'Ada Bello turned it off · Reason: Mailbox down',
    });
    expect(notificationTarget('security.mfa_requirement_disabled')).toBe('setup');
  });
});

describe('helpers', () => {
  it('parsePayload tolerates malformed JSON', () => {
    expect(parsePayload({ payload: '{bad' })).toEqual({});
  });

  it('summarizeItems caps the list', () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({ name: `Item ${n}`, quantity: 1 }));
    expect(summarizeItems(items)).toBe('1× Item 1, 1× Item 2, 1× Item 3 +2 more');
  });

  it('notificationIntent sends a stock-request notification to Stock → Requests with that request, and nothing else anywhere', () => {
    expect(notificationIntent({ type: 'stock.transfer_requested', payload: { requestId: 5 } })).toEqual({ posTab: 'stock', stockTab: 'requests', requestId: '5' });
    expect(notificationIntent({ type: 'stock.transfer_request_rejected', payload: JSON.stringify({ requestId: 7 }) }).requestId).toBe('7');
    expect(notificationIntent({ type: 'stock.transfer_request_issued', payload: {} }).requestId).toBeNull();
    expect(notificationIntent({ type: 'stock.out_of_stock', payload: { name: 'Gin' } })).toBeNull();
    expect(notificationIntent({ type: 'guest.checked_in', payload: {} })).toBeNull();
  });

  it('describes a handover: one tab by name, several by count, with who, where and why', () => {
    const one = describeNotification({
      type: 'pos.tabs_handed_over',
      payload: JSON.stringify({ count: 1, tabs: [{ id: '9', label: 'Table 4' }], outletNames: ['Main Bar'], fromName: 'Ada Bello', reason: 'End of shift' }),
    });
    expect(one).toEqual({ title: 'Table 4 handed to you', detail: 'From Ada Bello · Main Bar · End of shift' });
    const several = describeNotification({ type: 'pos.tabs_handed_over', payload: { count: 3, tabs: [], outletNames: ['Main Bar', 'Pool Bar'], fromName: null } });
    expect(several).toEqual({ title: '3 tabs handed to you', detail: 'Main Bar, Pool Bar' });
    expect(notificationIntent({ type: 'pos.tabs_handed_over', payload: {} })).toEqual({ posTab: 'register' });
    expect(notificationTarget('pos.tabs_handed_over')).toBe('pos');
  });

  it('notificationTarget maps each family to its screen', () => {
    expect(notificationTarget('qr_ordering.guest_order_placed')).toBe('pos');
    expect(notificationTarget('stock.out_of_stock')).toBe('pos');
    expect(notificationTarget('guest.checked_out')).toBe('booking');
    expect(notificationTarget('room.became_dirty')).toBe('housekeeping');
    expect(notificationTarget('night_audit.completed')).toBe('night_audit');
    expect(notificationTarget('other.thing')).toBeNull();
  });

  it('timeAgo buckets elapsed time', () => {
    const now = Date.parse('2026-09-13T12:00:00Z');
    expect(timeAgo('2026-09-13T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-09-13T11:55:00Z', now)).toBe('5m ago');
    expect(timeAgo('2026-09-13T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2026-09-11T12:00:00Z', now)).toBe('2d ago');
  });
});
