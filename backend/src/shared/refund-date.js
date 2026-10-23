'use strict';

/**
 * The date a refund counts on in the reports: the calendar date, in the property's own timezone, on which the refund
 * was captured. A refund has no business-date column of its own (and the reports must not gain one), so this is the
 * nearest honest answer to "the day the refund was processed". Between midnight and Night Audit it can be one day
 * ahead of the property's open business date; that is the one known difference.
 *
 * A property with a missing or unusable timezone falls back to the UTC date rather than failing a report.
 */

const { calendarDateInZone } = require('./timezone');

function refundDate(capturedAt, timeZone) {
  const instant = new Date(capturedAt);
  if (timeZone) {
    try {
      return calendarDateInZone(instant, timeZone);
    } catch {
      // fall through to UTC
    }
  }
  return instant.toISOString().slice(0, 10);
}

/**
 * Maps each refund payment id to the date it counts on: the business date recorded when it was processed
 * (`refund_reconciliations.business_date`), else its capture date in the property's timezone.
 * @param {Array<{id: *, captured_at: *}>} refunds
 */
async function refundDates({ db, refunds, timeZone }) {
  const rows = refunds.length === 0 ? [] : await db.table('refund_reconciliations').whereIn('payment_id', refunds.map((refund) => refund.id)).whereNotNull('business_date').select('payment_id', 'business_date');
  const recorded = new Map(rows.map((row) => [String(row.payment_id), String(row.business_date).slice(0, 10)]));
  return new Map(refunds.map((refund) => [String(refund.id), recorded.get(String(refund.id)) ?? refundDate(refund.captured_at, timeZone)]));
}

module.exports = { refundDate, refundDates };
