'use strict';

/**
 * Gap closure, user-reported: "I clicked run night audit on the 17th and it
 * changed to the 18th, but in real sense we are not in the 18th." Pure-
 * function coverage for `assertBusinessDateHasEnded`
 * (`src/modules/night-audit/service.js`) — the guard that refuses to
 * advance a property's business date past its own real, local calendar
 * day. HTTP-level proof that this is actually wired into `runNightAudit`
 * lives in `tests/night-audit/night-audit.test.js`.
 */

const { assertBusinessDateHasEnded } = require('../../src/modules/night-audit/service');

describe('assertBusinessDateHasEnded (night audit cannot advance past the property\'s own real "today")', () => {
  it('allows the run when the resulting business date is still in the past relative to the property\'s local today', () => {
    expect(() =>
      assertBusinessDateHasEnded({
        businessDate: '2026-09-16',
        nextBusinessDate: '2026-09-17',
        property: { timezone: 'Africa/Lagos' },
        now: new Date('2026-09-20T10:00:00Z'), // real "today" in Lagos is well past the 17th
      })
    ).not.toThrow();
  });

  it('allows the run when the resulting business date exactly tallies with the property\'s local today', () => {
    // Lagos is UTC+1 — 2026-09-17T23:30Z is already 2026-09-18 in Lagos.
    expect(() =>
      assertBusinessDateHasEnded({
        businessDate: '2026-09-17',
        nextBusinessDate: '2026-09-18',
        property: { timezone: 'Africa/Lagos' },
        now: new Date('2026-09-17T23:30:00Z'),
      })
    ).not.toThrow();
  });

  it('refuses the run when the resulting business date would be later than the property\'s own local today — the exact bug reported', () => {
    // Real "now" is still 2026-09-17 in Lagos (UTC+1) — closing the 17th
    // would advance to the 18th, a day that has not begun there yet.
    expect(() =>
      assertBusinessDateHasEnded({
        businessDate: '2026-09-17',
        nextBusinessDate: '2026-09-18',
        property: { timezone: 'Africa/Lagos' },
        now: new Date('2026-09-17T15:00:00Z'),
      })
    ).toThrow(/cannot run yet/);
  });

  it('reports the exact business date, next business date, and property-local today on refusal', () => {
    try {
      assertBusinessDateHasEnded({
        businessDate: '2026-09-17',
        nextBusinessDate: '2026-09-18',
        property: { timezone: 'Africa/Lagos' },
        now: new Date('2026-09-17T15:00:00Z'),
      });
      throw new Error('expected assertBusinessDateHasEnded to throw');
    } catch (error) {
      expect(error.code).toBe('BUSINESS_RULE_NIGHT_AUDIT_PREMATURE');
      expect(error.httpStatus).toBe(422);
      expect(error.details).toEqual({
        businessDate: '2026-09-17',
        nextBusinessDate: '2026-09-18',
        todayInPropertyTimezone: '2026-09-17',
        propertyTimezone: 'Africa/Lagos',
      });
    }
  });

  it('uses the property\'s OWN timezone, not UTC — a date that is "tomorrow" in UTC can still be premature far enough west', () => {
    // 2026-09-17T23:30Z is already 2026-09-18 in UTC, but still 2026-09-17
    // for a UTC-10 property (e.g. Pacific/Honolulu) — closing the 17th
    // there and advancing to the 18th is still premature.
    expect(() =>
      assertBusinessDateHasEnded({
        businessDate: '2026-09-17',
        nextBusinessDate: '2026-09-18',
        property: { timezone: 'Pacific/Honolulu' },
        now: new Date('2026-09-17T23:30:00Z'),
      })
    ).toThrow(/cannot run yet/);
  });

  it('skips the check entirely for a property with no timezone configured, rather than guessing', () => {
    expect(() =>
      assertBusinessDateHasEnded({
        businessDate: '2099-01-01', // absurdly far in the future — still not blocked
        nextBusinessDate: '2099-01-02',
        property: { timezone: null },
        now: new Date('2026-09-17T15:00:00Z'),
      })
    ).not.toThrow();
  });

  it('skips the check for a garbage, non-IANA timezone string rather than crashing night audit', () => {
    expect(() =>
      assertBusinessDateHasEnded({
        businessDate: '2099-01-01',
        nextBusinessDate: '2099-01-02',
        property: { timezone: 'LAGOS' }, // a real value seen in this codebase's own seeded data
        now: new Date('2026-09-17T15:00:00Z'),
      })
    ).not.toThrow();
  });
});
