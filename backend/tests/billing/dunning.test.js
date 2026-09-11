'use strict';

const { isDunningAttemptDue, isDunningExhausted, nextAttemptDate, DUNNING_SCHEDULE_DAYS } = require('../../src/modules/billing/dunning');

describe('dunning schedule (PLAN.md Phase 5) — pure functions', () => {
  it('the confirmed schedule is day 0/3/7/10/14 — a genuine retry-and-notify sequence over roughly a 7-14 day window', () => {
    expect(DUNNING_SCHEDULE_DAYS).toEqual([0, 3, 7, 10, 14]);
  });

  describe('isDunningAttemptDue', () => {
    it('the first attempt (attempt_count 0) is due the moment due_at arrives, not one day after', () => {
      const dueAt = new Date('2027-01-01T00:00:00Z');
      const now = new Date('2027-01-01T00:00:00Z');
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 0 }, now)).toBe(true);
    });

    it('the first attempt is NOT due before due_at', () => {
      const dueAt = new Date('2027-01-02T00:00:00Z');
      const now = new Date('2027-01-01T00:00:00Z');
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 0 }, now)).toBe(false);
    });

    it('after one failed attempt, the second retry is not due until day 3', () => {
      const dueAt = new Date('2027-01-01T00:00:00Z');
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 1 }, new Date('2027-01-02T00:00:00Z'))).toBe(false); // day 1
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 1 }, new Date('2027-01-04T00:00:00Z'))).toBe(true); // day 3
    });

    it('after two failed attempts, the third retry is not due until day 7', () => {
      const dueAt = new Date('2027-01-01T00:00:00Z');
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 2 }, new Date('2027-01-04T00:00:00Z'))).toBe(false); // day 3
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 2 }, new Date('2027-01-08T00:00:00Z'))).toBe(true); // day 7
    });

    it('after three failed attempts, the fourth retry (the "final warning" stage) is not due until day 10', () => {
      const dueAt = new Date('2027-01-01T00:00:00Z');
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 3 }, new Date('2027-01-08T00:00:00Z'))).toBe(false); // day 7
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 3 }, new Date('2027-01-11T00:00:00Z'))).toBe(true); // day 10
    });

    it('after four failed attempts, the fifth and final retry is not due until day 14', () => {
      const dueAt = new Date('2027-01-01T00:00:00Z');
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 4 }, new Date('2027-01-11T00:00:00Z'))).toBe(false); // day 10
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 4 }, new Date('2027-01-15T00:00:00Z'))).toBe(true); // day 14
    });

    it('once exhausted (attempt_count 5), no further attempt is ever due, no matter how much time passes', () => {
      const dueAt = new Date('2027-01-01T00:00:00Z');
      expect(isDunningAttemptDue({ due_at: dueAt, attempt_count: 5 }, new Date('2028-01-01T00:00:00Z'))).toBe(false);
    });
  });

  describe('isDunningExhausted', () => {
    it('is false for every attempt count within the schedule (0 through 4)', () => {
      expect(isDunningExhausted(0)).toBe(false);
      expect(isDunningExhausted(1)).toBe(false);
      expect(isDunningExhausted(2)).toBe(false);
      expect(isDunningExhausted(3)).toBe(false);
      expect(isDunningExhausted(4)).toBe(false);
    });

    it('is true exactly once the schedule\'s own 5 attempts are used up', () => {
      expect(isDunningExhausted(5)).toBe(true);
      expect(isDunningExhausted(6)).toBe(true);
    });
  });

  describe('nextAttemptDate', () => {
    it('names the correct upcoming date for each retry stage', () => {
      const dueAt = '2027-01-01';
      expect(nextAttemptDate(dueAt, 0)).toBe('2027-01-01'); // day 0
      expect(nextAttemptDate(dueAt, 1)).toBe('2027-01-04'); // day 3
      expect(nextAttemptDate(dueAt, 2)).toBe('2027-01-08'); // day 7
      expect(nextAttemptDate(dueAt, 3)).toBe('2027-01-11'); // day 10
      expect(nextAttemptDate(dueAt, 4)).toBe('2027-01-15'); // day 14
    });

    it('returns null once exhausted — there is no next retry left to name (that failure gets the suspension notice instead)', () => {
      expect(nextAttemptDate('2027-01-01', 5)).toBeNull();
    });
  });
});
