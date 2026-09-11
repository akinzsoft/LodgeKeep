'use strict';

/**
 * Pure-function tests for `src/modules/platform/health.js` — PLAN.md
 * Phase 5 ("Platform console — tenant list, health"). No database.
 */

const { trialDaysRemaining, resolvePlanForRoster } = require('../../src/modules/platform/health');

describe('trialDaysRemaining', () => {
  const now = new Date('2027-01-10T00:00:00.000Z');

  it('returns the exact positive integer of days remaining for an in-trial tenant', () => {
    const tenant = { status: 'trial', trial_ends_at: '2027-01-15T00:00:00.000Z' };
    expect(trialDaysRemaining(tenant, now)).toBe(5);
  });

  it('rounds up a partial day rather than truncating', () => {
    // 3 hours from "now" — a real, positive amount of time left, not zero.
    const tenant = { status: 'trial', trial_ends_at: '2027-01-10T03:00:00.000Z' };
    expect(trialDaysRemaining(tenant, now)).toBe(1);
  });

  it('returns a genuine negative integer for a lapsed trial not yet swept, never clamped to 0', () => {
    const tenant = { status: 'trial', trial_ends_at: '2027-01-05T00:00:00.000Z' };
    expect(trialDaysRemaining(tenant, now)).toBe(-5);
  });

  it('returns null for a non-trial status', () => {
    const tenant = { status: 'active', trial_ends_at: '2027-01-15T00:00:00.000Z' };
    expect(trialDaysRemaining(tenant, now)).toBeNull();
  });

  it('returns null for a trial tenant with no trial_ends_at set', () => {
    const tenant = { status: 'trial', trial_ends_at: null };
    expect(trialDaysRemaining(tenant, now)).toBeNull();
  });
});

describe('resolvePlanForRoster', () => {
  const plans = [
    { id: 1, code: 'legacy', name: 'Legacy', is_active: false },
    { id: 2, code: 'standard', name: 'Standard', is_active: true },
  ];

  it('resolves the tenant\'s own explicit plan_id when it exists in the catalogue', () => {
    const tenant = { plan_id: 1 };
    expect(resolvePlanForRoster(plans, tenant)).toEqual(plans[0]);
  });

  it('falls back to the first active plan when plan_id is null', () => {
    const tenant = { plan_id: null };
    expect(resolvePlanForRoster(plans, tenant)).toEqual(plans[1]);
  });

  it('falls back to the first active plan when plan_id references a row absent from the catalogue (a dangling reference)', () => {
    const tenant = { plan_id: 999 };
    expect(resolvePlanForRoster(plans, tenant)).toEqual(plans[1]);
  });

  it('matches plan_id across string/number type mismatch (a MySQL BIGINT string vs a JS number id)', () => {
    const tenant = { plan_id: '2' };
    expect(resolvePlanForRoster(plans, tenant)).toEqual(plans[1]);
  });

  it('returns null when no plan resolves at all (an empty or fully-inactive catalogue)', () => {
    expect(resolvePlanForRoster([], { plan_id: null })).toBeNull();
    expect(resolvePlanForRoster([{ id: 1, code: 'legacy', name: 'Legacy', is_active: false }], { plan_id: null })).toBeNull();
  });
});
