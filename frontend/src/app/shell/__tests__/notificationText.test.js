import { describe, it, expect } from 'vitest';
import { describeNotification, notificationTarget, parsePayload, summarizeItems, timeAgo } from '../notificationText.js';

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
});

describe('helpers', () => {
  it('parsePayload tolerates malformed JSON', () => {
    expect(parsePayload({ payload: '{bad' })).toEqual({});
  });

  it('summarizeItems caps the list', () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({ name: `Item ${n}`, quantity: 1 }));
    expect(summarizeItems(items)).toBe('1× Item 1, 1× Item 2, 1× Item 3 +2 more');
  });

  it('notificationTarget maps each family to its screen', () => {
    expect(notificationTarget('qr_ordering.guest_order_placed')).toBe('pos');
    expect(notificationTarget('stock.out_of_stock')).toBe('pos');
    expect(notificationTarget('guest.checked_out')).toBe('booking');
    expect(notificationTarget('room.became_dirty')).toBe('housekeeping');
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
