/**
 * Business-date ranges for the supermarket "All sales" report (dates are plain `YYYY-MM-DD` strings; the
 * arithmetic is in UTC so a time zone can never shift a day).
 */

const DAY_MS = 86400000;
const toMs = (date) => Date.parse(`${date}T00:00:00Z`);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export function shiftDate(date, days) {
  return fromMs(toMs(date) + days * DAY_MS);
}

/** The shortcuts, relative to the property's current business date. */
export function presetRange(preset, businessDate) {
  if (preset === 'last7') return { from: shiftDate(businessDate, -6), to: businessDate };
  if (preset === 'month') return { from: `${businessDate.slice(0, 8)}01`, to: businessDate };
  return { from: businessDate, to: businessDate }; // 'today'
}
