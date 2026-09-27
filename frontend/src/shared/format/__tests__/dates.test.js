import { describe, it, expect } from 'vitest';
import { addDays, formatDate, nightsBetween, weekdayOf } from '../dates.js';

describe('business date formatting', () => {
  it('formats from the date\'s own digits', () => {
    expect(formatDate('2026-09-16')).toBe('16 Sep 2026');
    expect(formatDate('2026-09-16', { weekday: true })).toBe('Wed 16 Sep 2026');
    expect(formatDate('2026-09-16', { weekday: true, year: false })).toBe('Wed 16 Sep');
    expect(weekdayOf('2027-01-01')).toBe('Fri');
  });

  it('leaves anything that is not a date alone, and shows a dash for nothing', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('soon')).toBe('soon');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts nights, never negative', () => {
    expect(nightsBetween('2026-09-16', '2026-09-23')).toBe(7);
    expect(nightsBetween('2026-09-23', '2026-09-16')).toBe(0);
    expect(nightsBetween(null, '2026-09-16')).toBe(0);
  });
});
