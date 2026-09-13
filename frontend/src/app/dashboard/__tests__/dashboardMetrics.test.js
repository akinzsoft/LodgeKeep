import { describe, it, expect } from 'vitest';
import {
  bookingsByRoomType,
  countBookings,
  countDelta,
  countNewGuests,
  dateWindow,
  formatLongDate,
  monthRange,
  greetingForHour,
  moneyPercentDelta,
  newVsReturningByDay,
  ratio,
  shiftDate,
  shortWeekday,
  totalMoney,
  wholePercentages,
} from '../dashboardMetrics.js';

function reservation(overrides) {
  return { id: '1', guest_id: '1', room_type_id: '1', status: 'confirmed', arrival_date: '2026-09-10', ...overrides };
}

describe('dashboardMetrics', () => {
  it('shifts business dates across month and year boundaries without touching the viewer timezone', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(dateWindow('2026-09-10')).toEqual(['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']);
  });

  it('counts only room-holding bookings arriving inside the window, inclusive', () => {
    const rows = [
      reservation({ id: '1', arrival_date: '2026-09-04' }),
      reservation({ id: '2', arrival_date: '2026-09-10', status: 'checked_out' }),
      reservation({ id: '3', arrival_date: '2026-09-09', status: 'cancelled' }),
      reservation({ id: '4', arrival_date: '2026-09-09', status: 'waitlisted' }),
      reservation({ id: '5', arrival_date: '2026-09-03' }),
    ];
    expect(countBookings(rows, '2026-09-04', '2026-09-10')).toBe(2);
  });

  it('counts a guest as new only on their first-ever stay, and only once when their first night has two rooms', () => {
    const rows = [
      reservation({ id: '1', guest_id: '7', arrival_date: '2026-08-30' }),
      reservation({ id: '2', guest_id: '7', arrival_date: '2026-09-08' }),
      reservation({ id: '3', guest_id: '8', arrival_date: '2026-09-09' }),
      reservation({ id: '4', guest_id: '8', arrival_date: '2026-09-09' }),
    ];
    expect(countNewGuests(rows, '2026-09-04', '2026-09-10')).toBe(1);
    expect(countNewGuests(rows, '2026-08-28', '2026-09-03')).toBe(1);
  });

  it('ignores a cancelled earlier booking when deciding whether a guest is returning', () => {
    const rows = [
      reservation({ id: '1', guest_id: '7', arrival_date: '2026-08-30', status: 'cancelled' }),
      reservation({ id: '2', guest_id: '7', arrival_date: '2026-09-08' }),
    ];
    expect(newVsReturningByDay(rows, ['2026-09-08'])).toEqual([{ date: '2026-09-08', newGuests: 1, returningGuests: 0 }]);
  });

  it('splits each day into new vs. returning arrivals', () => {
    const rows = [
      reservation({ id: '1', guest_id: '7', arrival_date: '2026-08-30' }),
      reservation({ id: '2', guest_id: '7', arrival_date: '2026-09-08' }),
      reservation({ id: '3', guest_id: '8', arrival_date: '2026-09-08' }),
    ];
    expect(newVsReturningByDay(rows, ['2026-09-07', '2026-09-08'])).toEqual([
      { date: '2026-09-07', newGuests: 0, returningGuests: 0 },
      { date: '2026-09-08', newGuests: 1, returningGuests: 1 },
    ]);
  });

  it('produces whole percentages that always sum to exactly 100', () => {
    expect(wholePercentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercentages([3, 1])).toEqual([75, 25]);
    expect(wholePercentages([0, 0])).toEqual([0, 0]);
  });

  it('groups bookings by room type with real names, a labelled fallback, and folds a 5th+ type into "Other"', () => {
    const rows = [
      reservation({ id: '1', room_type_id: '1' }),
      reservation({ id: '2', room_type_id: '1' }),
      reservation({ id: '3', room_type_id: '2' }),
      reservation({ id: '4', room_type_id: '9', status: 'no_show' }),
    ];
    expect(bookingsByRoomType(rows, [{ id: '1', name: 'Deluxe' }])).toEqual([
      { key: '1', label: 'Deluxe', count: 2, percent: 67 },
      { key: '2', label: 'Room type 2', count: 1, percent: 33 },
    ]);

    const many = ['1', '2', '3', '4', '5'].map((type, index) => reservation({ id: String(index), room_type_id: type }));
    const segments = bookingsByRoomType(many, []);
    expect(segments).toHaveLength(4);
    expect(segments[3]).toMatchObject({ key: 'other', label: 'Other', count: 2 });
  });

  it('resolves a business date to its calendar month, leap years included', () => {
    expect(monthRange('2026-09-13')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthRange('2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('limits the room-type breakdown to a date range when one is given', () => {
    const rows = [
      reservation({ id: '1', room_type_id: '1', arrival_date: '2026-08-31' }),
      reservation({ id: '2', room_type_id: '2', arrival_date: '2026-09-01' }),
      reservation({ id: '3', room_type_id: '2', arrival_date: '2026-09-30' }),
    ];
    expect(bookingsByRoomType(rows, [], { from: '2026-09-01', to: '2026-09-30' })).toEqual([
      { key: '2', label: 'Room type 2', count: 2, percent: 100 },
    ]);
  });

  it('describes count and money deltas, and never invents a percent against a zero baseline', () => {
    expect(countDelta(5, 3)).toEqual({ direction: 'up', label: '+2' });
    expect(countDelta(1, 4)).toEqual({ direction: 'down', label: '−3' });
    expect(countDelta(2, 2)).toEqual({ direction: 'flat', label: '0' });
    expect(moneyPercentDelta('250.00', '200.00')).toEqual({ direction: 'up', label: '+25%' });
    expect(moneyPercentDelta('150.00', '200.00')).toEqual({ direction: 'down', label: '−25%' });
    expect(moneyPercentDelta('5.00', '0.00')).toBeNull();
  });

  it('sums money exactly, never with float error', () => {
    expect(totalMoney(['0.10', '0.20'])).toBe('0.30');
  });

  it('returns a clamped ratio, or null against a zero denominator', () => {
    expect(ratio(3, 4)).toBe(0.75);
    expect(ratio(5, 4)).toBe(1);
    expect(ratio(1, 0)).toBeNull();
  });

  it("greets by the hour at the property's own timezone, not the viewer's", () => {
    const instant = new Date('2026-09-10T13:00:00Z');
    expect(greetingForHour(instant, 'Africa/Lagos')).toBe('Good afternoon'); // 14:00 in Lagos
    expect(greetingForHour(instant, 'Asia/Tokyo')).toBe('Good evening'); // 22:00 in Tokyo
    expect(greetingForHour(new Date('2026-09-10T08:00:00Z'), 'Africa/Lagos')).toBe('Good morning');
    expect(() => greetingForHour(instant, 'Not/AZone')).not.toThrow();
  });

  it('formats the long date and weekday labels', () => {
    expect(formatLongDate(new Date('2026-09-10T08:00:00Z'), 'Africa/Lagos')).toBe('Thursday, 10 September');
    // 23:30 UTC is already the next day in Lagos.
    expect(formatLongDate(new Date('2026-09-10T23:30:00Z'), 'Africa/Lagos')).toBe('Friday, 11 September');
    expect(shortWeekday('2026-09-10')).toBe('Thu');
  });
});
