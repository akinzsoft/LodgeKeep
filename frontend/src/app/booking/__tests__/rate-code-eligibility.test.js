import { describe, it, expect } from 'vitest';
import { isRateCodeValidForStay, filterRateCodesForStay } from '../rate-code-eligibility.js';

const bar = { id: 1, code: 'BAR', valid_from: '2020-01-01', valid_to: null };
const summerPromo = { id: 2, code: 'SUMMER26', valid_from: '2026-06-01', valid_to: '2026-08-31' };
const notYetOpen = { id: 3, code: 'NEWPLAN', valid_from: '2027-01-01', valid_to: null };
const lapsed = { id: 4, code: 'OLDPROMO', valid_from: '2020-01-01', valid_to: '2021-12-31' };

describe('isRateCodeValidForStay', () => {
  it('is valid when the code has no end date and starts before the stay', () => {
    expect(isRateCodeValidForStay(bar, '2026-09-10', '2026-09-12')).toBe(true);
  });

  it('is valid when the whole stay falls inside a bounded window', () => {
    expect(isRateCodeValidForStay(summerPromo, '2026-06-15', '2026-06-18')).toBe(true);
  });

  it('is invalid when the stay starts before the code opens', () => {
    expect(isRateCodeValidForStay(notYetOpen, '2026-09-10', '2026-09-12')).toBe(false);
  });

  it('is invalid when the code has already lapsed before the stay', () => {
    expect(isRateCodeValidForStay(lapsed, '2026-09-10', '2026-09-12')).toBe(false);
  });

  it('checks the LAST NIGHT against valid_to, not the checkout/departure day itself', () => {
    // A promo valid through Aug 31 (the last night it can be sold) still
    // covers an arrival Aug 30 / departure Sep 1 stay (nights: Aug 30, Aug 31).
    expect(isRateCodeValidForStay(summerPromo, '2026-08-30', '2026-09-01')).toBe(true);
    // But not a stay whose last NIGHT is Sep 1 (arrival Aug 31 / departure Sep 2).
    expect(isRateCodeValidForStay(summerPromo, '2026-08-31', '2026-09-02')).toBe(false);
  });

  it('treats missing dates as valid (nothing searched yet)', () => {
    expect(isRateCodeValidForStay(summerPromo, '', '')).toBe(true);
    expect(isRateCodeValidForStay(summerPromo, '2026-09-10', '')).toBe(true);
  });
});

describe('filterRateCodesForStay', () => {
  it('narrows to only the codes valid for the searched dates, alphabetically', () => {
    const result = filterRateCodesForStay([lapsed, bar, summerPromo, notYetOpen], '2026-06-15', '2026-06-18');
    expect(result.map((rc) => rc.code)).toEqual(['BAR', 'SUMMER26']);
  });

  it('never excludes a rate code by room type — the same result regardless of any caller-side room type context', () => {
    // rate_codes carries no room-type column at all (backend/migrations/
    // 20260905092000_create_rate_codes.js) — this function takes no
    // room-type argument at all, proving there is nothing to filter by.
    expect(filterRateCodesForStay.length).toBe(3); // (rateCodes, arrivalDate, departureDate) only
  });

  it('falls back to the full, alphabetical list rather than leaving nothing selectable', () => {
    const result = filterRateCodesForStay([lapsed, notYetOpen], '2026-06-15', '2026-06-18');
    expect(result.map((rc) => rc.code)).toEqual(['NEWPLAN', 'OLDPROMO']);
  });

  it('keeps a corporate/negotiated code alongside BAR when both are valid — filtering never reduces to a single choice', () => {
    const corporate = { id: 5, code: 'CORP-ACME', valid_from: '2020-01-01', valid_to: null };
    const result = filterRateCodesForStay([bar, corporate], '2026-09-10', '2026-09-12');
    expect(result.map((rc) => rc.code)).toEqual(['BAR', 'CORP-ACME']);
  });

  it('handles a null/undefined list', () => {
    expect(filterRateCodesForStay(null, '2026-09-10', '2026-09-12')).toEqual([]);
    expect(filterRateCodesForStay(undefined, '2026-09-10', '2026-09-12')).toEqual([]);
  });
});
