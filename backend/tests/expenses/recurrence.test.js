'use strict';

/**
 * Pure-function coverage for `expenses/recurrence.js`'s due-date logic —
 * no database, mirrors `tests/billing/pure-functions.test.js`'s own
 * `addOneMonth` boundary-case coverage exactly (Jan 31 -> Feb 28/29, year
 * rollover), extended to the generalized `addMonthsClamped` and the
 * higher-level `computeNextDueDate`/`isScheduleDue`.
 */

const { addMonthsClamped, computeNextDueDate, isScheduleDue } = require('../../src/modules/expenses/recurrence');

describe('addMonthsClamped', () => {
  it('adds a whole number of months on an ordinary day', () => {
    expect(addMonthsClamped('2026-01-15', 1, 15)).toBe('2026-02-15');
    expect(addMonthsClamped('2026-01-15', 3, 15)).toBe('2026-04-15');
    expect(addMonthsClamped('2026-01-15', 12, 15)).toBe('2027-01-15');
  });

  it('clamps day 31 into a 30-day month', () => {
    expect(addMonthsClamped('2026-01-31', 1, 31)).toBe('2026-02-28'); // 2026 is not a leap year
    expect(addMonthsClamped('2026-04-30', 1, 31)).toBe('2026-05-31'); // clamped forward, uncapped once May (31 days) is reached
  });

  it('clamps Feb 29 target in a non-leap year, but not in a leap year', () => {
    expect(addMonthsClamped('2027-01-29', 1, 29)).toBe('2027-02-28'); // 2027 not a leap year
    expect(addMonthsClamped('2028-01-29', 1, 29)).toBe('2028-02-29'); // 2028 IS a leap year
  });

  it('rolls over the year correctly for a multi-month jump', () => {
    expect(addMonthsClamped('2026-11-15', 3, 15)).toBe('2027-02-15');
    expect(addMonthsClamped('2026-12-31', 12, 31)).toBe('2027-12-31');
  });
});

describe('computeNextDueDate', () => {
  describe('monthly/quarterly/annually', () => {
    it('non-inclusive: advances by exactly one period from the schedule\'s own prior due date', () => {
      expect(computeNextDueDate({ fromDate: '2026-01-15', frequency: 'monthly', dayOfMonth: 15 })).toBe('2026-02-15');
      expect(computeNextDueDate({ fromDate: '2026-01-15', frequency: 'quarterly', dayOfMonth: 15 })).toBe('2026-04-15');
      expect(computeNextDueDate({ fromDate: '2026-01-15', frequency: 'annually', dayOfMonth: 15 })).toBe('2027-01-15');
    });

    it('non-inclusive: re-expands from a clamped date back to the real target day once the destination month is long enough', () => {
      // Jan 31 schedule clamped to Feb 28 last cycle; the NEXT advance from
      // Feb 28 targets March, which has 31 real days, so it un-clamps.
      expect(computeNextDueDate({ fromDate: '2026-02-28', frequency: 'monthly', dayOfMonth: 31 })).toBe('2026-03-31');
    });

    it('inclusive, initial schedule: today already matches the target day — due today, not one period later', () => {
      expect(computeNextDueDate({ fromDate: '2026-01-15', frequency: 'monthly', dayOfMonth: 15, inclusive: true })).toBe('2026-01-15');
    });

    it('inclusive, initial schedule: target day still ahead this month — due later this same month', () => {
      expect(computeNextDueDate({ fromDate: '2026-01-10', frequency: 'monthly', dayOfMonth: 15, inclusive: true })).toBe('2026-01-15');
    });

    it('inclusive, initial schedule: target day already passed this month — due next month', () => {
      expect(computeNextDueDate({ fromDate: '2026-01-20', frequency: 'monthly', dayOfMonth: 15, inclusive: true })).toBe('2026-02-15');
    });
  });

  describe('weekly', () => {
    it('non-inclusive: the next matching day-of-week, never today even if it matches', () => {
      // 2026-01-05 is a Monday (day 1).
      expect(computeNextDueDate({ fromDate: '2026-01-05', frequency: 'weekly', dayOfWeek: 1 })).toBe('2026-01-12');
      expect(computeNextDueDate({ fromDate: '2026-01-05', frequency: 'weekly', dayOfWeek: 3 })).toBe('2026-01-07'); // next Wednesday
    });

    it('inclusive: returns today when today already matches', () => {
      expect(computeNextDueDate({ fromDate: '2026-01-05', frequency: 'weekly', dayOfWeek: 1, inclusive: true })).toBe('2026-01-05');
    });

    it('inclusive: returns the next matching day when today does not match', () => {
      expect(computeNextDueDate({ fromDate: '2026-01-05', frequency: 'weekly', dayOfWeek: 3, inclusive: true })).toBe('2026-01-07');
    });
  });
});

describe('isScheduleDue', () => {
  it('is due when next_due_date is on or before the business date, and active', () => {
    expect(isScheduleDue({ schedule: { status: 'active', next_due_date: '2026-01-15' }, businessDate: '2026-01-15' })).toBe(true);
    expect(isScheduleDue({ schedule: { status: 'active', next_due_date: '2026-01-10' }, businessDate: '2026-01-15' })).toBe(true); // overdue, still due
  });

  it('is not due when next_due_date is in the future', () => {
    expect(isScheduleDue({ schedule: { status: 'active', next_due_date: '2026-01-20' }, businessDate: '2026-01-15' })).toBe(false);
  });

  it('is never due while paused, regardless of date', () => {
    expect(isScheduleDue({ schedule: { status: 'paused', next_due_date: '2026-01-01' }, businessDate: '2026-01-15' })).toBe(false);
  });
});
