'use strict';

/**
 * Ageing-bucket computation — PLAN.md Phase 4, TESTING.md AR-2 ("Ageing
 * buckets — Correct at 30/60/90 boundaries"). Pure, no database — the same
 * "pull business logic into a directly unit-testable function" discipline
 * `resolveEffectiveTax`/`computeEarlyLateFee`/`activityCutoffDate` already
 * established elsewhere in this codebase, built and proven at every
 * boundary BEFORE anything here touches the database.
 *
 * `asOfDate` is always the property's own `current_business_date`, never
 * wall-clock `new Date()` — ARCHITECTURE.md §6: a report run today buckets
 * against the property's own accounting date, not physical today. Every
 * date here is a plain 'YYYY-MM-DD' string, compared via UTC-normalized
 * `Date.UTC(...)` construction so no local timezone or DST rule can shift a
 * boundary by a day, the same defensive pattern `activityCutoffDate`
 * (`src/modules/reservations/service.js`) already uses for the identical
 * reason.
 *
 * Money is summed via `src/shared/money.js`'s exact BigInt-cents arithmetic
 * — never `Number()` — per ARCHITECTURE.md §1's "money is exact, always."
 */

const { sumMoney, negateMoney, compareMoney } = require('../../shared/money');

function parseDateUTC(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole days from `fromDate` to `toDate` ('YYYY-MM-DD' strings) — positive when `toDate` is later. */
function daysBetween(fromDate, toDate) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((parseDateUTC(toDate) - parseDateUTC(fromDate)) / MS_PER_DAY);
}

const BUCKET_KEYS = ['current', 'bucket_1_30', 'bucket_31_60', 'bucket_61_90', 'bucket_90_plus'];

/**
 * @param {object} params
 * @param {{total_amount: string, appliedAmount: string, due_at: string}[]} params.invoices
 *   Pre-filtered to non-void invoices only — a voided invoice never counts
 *   toward anyone's outstanding balance (ARCHITECTURE.md §8's own
 *   "voided-never-real" instinct applied here).
 * @param {string} params.asOfDate  The property's own current_business_date.
 * @returns {{current: string, bucket_1_30: string, bucket_31_60: string, bucket_61_90: string, bucket_90_plus: string}}
 *
 * Boundary rule, each edge directly unit-tested: daysOverdue <= 0 → current
 * (not yet due, or due today); 1–30 inclusive → bucket_1_30; 31–60 →
 * bucket_31_60; 61–90 → bucket_61_90; > 90 → bucket_90_plus.
 */
function computeAgeingBuckets({ invoices, asOfDate }) {
  const buckets = Object.fromEntries(BUCKET_KEYS.map((key) => [key, '0.00']));

  for (const invoice of invoices) {
    const outstanding = sumMoney([invoice.total_amount, negateMoney(invoice.appliedAmount ?? '0.00')]);
    if (compareMoney(outstanding, '0.00') <= 0) continue; // fully paid (or a credit) — nothing outstanding to age

    const daysOverdue = daysBetween(invoice.due_at, asOfDate);
    const bucketKey =
      daysOverdue <= 0 ? 'current' : daysOverdue <= 30 ? 'bucket_1_30' : daysOverdue <= 60 ? 'bucket_31_60' : daysOverdue <= 90 ? 'bucket_61_90' : 'bucket_90_plus';

    buckets[bucketKey] = sumMoney([buckets[bucketKey], outstanding]);
  }

  return buckets;
}

/** `INV-{propertyId}-{next_number padded to 6 digits}` — a real, human-readable, quotable business field, not a ULID. See `ar_invoice_sequences`' own migration header for why. */
function formatInvoiceNumber(propertyId, nextNumber) {
  return `INV-${propertyId}-${String(nextNumber).padStart(6, '0')}`;
}

module.exports = { daysBetween, computeAgeingBuckets, formatInvoiceNumber, BUCKET_KEYS };
