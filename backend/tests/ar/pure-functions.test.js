'use strict';

/**
 * Unit tests for the AR module's pure functions — no database, no
 * fixtures. TESTING.md AR-2 ("Ageing buckets — Correct at 30/60/90
 * boundaries") is proven here at every edge, before anything in
 * `ar/service.js` touches the database.
 */

const { daysBetween, computeAgeingBuckets, formatInvoiceNumber } = require('../../src/modules/ar/ageing');

describe('daysBetween', () => {
  it('is positive when asOfDate is after the reference date', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });

  it('is zero for the same date', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('is negative when asOfDate is before the reference date', () => {
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(-30);
  });

  it('crosses a month boundary correctly', () => {
    expect(daysBetween('2026-01-15', '2026-02-15')).toBe(31);
  });
});

describe('computeAgeingBuckets (TESTING.md AR-2)', () => {
  function invoice({ total = '100.00', applied = '0.00', dueAt }) {
    return { total_amount: total, appliedAmount: applied, due_at: dueAt };
  }

  it('buckets a not-yet-due invoice as current', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2026-02-01' })], asOfDate: '2026-01-15' });
    expect(buckets.current).toBe('100.00');
    expect(buckets.bucket_1_30).toBe('0.00');
  });

  it('buckets an invoice due exactly today as current', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2026-01-15' })], asOfDate: '2026-01-15' });
    expect(buckets.current).toBe('100.00');
  });

  it('buckets exactly 30 days overdue as bucket_1_30, not bucket_31_60', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2025-12-16' })], asOfDate: '2026-01-15' });
    expect(buckets.bucket_1_30).toBe('100.00');
    expect(buckets.bucket_31_60).toBe('0.00');
  });

  it('buckets exactly 31 days overdue as bucket_31_60, not bucket_1_30', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2025-12-15' })], asOfDate: '2026-01-15' });
    expect(buckets.bucket_1_30).toBe('0.00');
    expect(buckets.bucket_31_60).toBe('100.00');
  });

  it('buckets exactly 60 days overdue as bucket_31_60, not bucket_61_90', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2025-11-16' })], asOfDate: '2026-01-15' });
    expect(buckets.bucket_31_60).toBe('100.00');
    expect(buckets.bucket_61_90).toBe('0.00');
  });

  it('buckets exactly 61 days overdue as bucket_61_90, not bucket_31_60', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2025-11-15' })], asOfDate: '2026-01-15' });
    expect(buckets.bucket_31_60).toBe('0.00');
    expect(buckets.bucket_61_90).toBe('100.00');
  });

  it('buckets exactly 90 days overdue as bucket_61_90, not bucket_90_plus', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2025-10-17' })], asOfDate: '2026-01-15' });
    expect(buckets.bucket_61_90).toBe('100.00');
    expect(buckets.bucket_90_plus).toBe('0.00');
  });

  it('buckets exactly 91 days overdue as bucket_90_plus, not bucket_61_90', () => {
    const buckets = computeAgeingBuckets({ invoices: [invoice({ dueAt: '2025-10-16' })], asOfDate: '2026-01-15' });
    expect(buckets.bucket_61_90).toBe('0.00');
    expect(buckets.bucket_90_plus).toBe('100.00');
  });

  it('excludes a fully-paid invoice from every bucket', () => {
    const buckets = computeAgeingBuckets({
      invoices: [invoice({ total: '100.00', applied: '100.00', dueAt: '2025-10-16' })],
      asOfDate: '2026-01-15',
    });
    expect(Object.values(buckets)).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00']);
  });

  it('sums multiple invoices landing in the same bucket exactly, using exact money arithmetic', () => {
    const buckets = computeAgeingBuckets({
      invoices: [invoice({ total: '10.10', dueAt: '2025-12-15' }), invoice({ total: '5.05', dueAt: '2025-12-01' })],
      asOfDate: '2026-01-15',
    });
    expect(buckets.bucket_31_60).toBe('15.15');
  });

  it('returns all-zero buckets for no invoices', () => {
    const buckets = computeAgeingBuckets({ invoices: [], asOfDate: '2026-01-15' });
    expect(Object.values(buckets)).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00']);
  });
});

describe('formatInvoiceNumber', () => {
  it('formats a human-readable, zero-padded, per-property invoice number', () => {
    expect(formatInvoiceNumber(3, 42)).toBe('INV-3-000042');
  });
});
