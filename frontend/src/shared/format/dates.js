/**
 * Business dates ('YYYY-MM-DD') for display — computed from the date's own
 * digits in UTC, never the viewer's timezone, so a property's business date
 * never shifts a day for a viewer elsewhere (ARCHITECTURE.md §6).
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ''));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/**
 * "16 Sep 2026"; `{ weekday: true }` → "Wed 16 Sep 2026"; `{ year: false }` → "16 Sep".
 * Anything that isn't a 'YYYY-MM-DD' date comes back unchanged ('—' for none).
 */
export function formatDate(date, { weekday = false, year = true } = {}) {
  const p = parts(date);
  if (!p) return date ? String(date) : '—';
  return `${weekday ? `${WEEKDAYS[p.weekday]} ` : ''}${p.day} ${MONTHS[p.month - 1]}${year ? ` ${p.year}` : ''}`;
}

/** "Wed" for a business date. */
export function weekdayOf(date) {
  const p = parts(date);
  return p ? WEEKDAYS[p.weekday] : '';
}

/** 'YYYY-MM-DD' shifted by whole days. */
export function addDays(date, days) {
  const p = parts(date);
  if (!p) return date;
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days)).toISOString().slice(0, 10);
}

/** Whole nights between arrival and departure (0 when either is missing or out of order). */
export function nightsBetween(arrival, departure) {
  const a = parts(arrival);
  const d = parts(departure);
  if (!a || !d) return 0;
  const diff = (Date.UTC(d.year, d.month - 1, d.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000;
  return diff > 0 ? diff : 0;
}
