import { describe, it, expect } from 'vitest';
import { shiftDate, presetRange } from '../salesRange.js';

describe('salesRange', () => {
  it('shifts a date across month and year ends without a time-zone slip', () => {
    expect(shiftDate('2027-03-01', -1)).toBe('2027-02-28');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('2027-01-02', -2)).toBe('2026-12-31');
    expect(shiftDate('2027-12-31', 1)).toBe('2028-01-01');
  });

  it('builds the shortcuts from the business date', () => {
    expect(presetRange('today', '2027-12-10')).toEqual({ from: '2027-12-10', to: '2027-12-10' });
    expect(presetRange('last7', '2027-12-10')).toEqual({ from: '2027-12-04', to: '2027-12-10' });
    expect(presetRange('last7', '2027-12-03')).toEqual({ from: '2027-11-27', to: '2027-12-03' });
    expect(presetRange('month', '2027-12-10')).toEqual({ from: '2027-12-01', to: '2027-12-10' });
  });
});
