/**
 * Pure metric computations for the Home dashboard — no fetching, no React,
 * directly unit-tested. Every trend window is anchored on the property's
 * BUSINESS date (ARCHITECTURE.md §6), never the wall clock: "this week" is
 * the 7 business days ending on `businessDate`, "last week" the 7 before.
 *
 * Money totals go through `shared/money.js` (exact BigInt cents). The only
 * place a money string becomes a plain Number is chart geometry and a
 * display-only percent-change ratio — never a value that is summed,
 * submitted, or shown as an amount.
 */
import { sumMoney } from '../../shared/money.js';

/** Statuses that genuinely hold (or held) a room — the same set Group Blocks' pickup and the last-room race use. Cancelled/no-show/expired/waitlisted bookings never count as a stay. */
export const HOLDING_STATUSES = new Set(['tentative', 'confirmed', 'checked_in', 'checked_out']);

export function shiftDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** The `days` business dates ending on (and including) `endDate`, oldest first. */
export function dateWindow(endDate, days = 7) {
  return Array.from({ length: days }, (_, index) => shiftDate(endDate, index - (days - 1)));
}

function holding(reservations) {
  return reservations.filter((reservation) => HOLDING_STATUSES.has(reservation.status));
}

function arrivalDate(reservation) {
  return String(reservation.arrival_date).slice(0, 10);
}

function inRange(date, from, to) {
  return date >= from && date <= to;
}

/** Bookings (room-holding reservations) arriving within [from, to]. */
export function countBookings(reservations, from, to) {
  return holding(reservations).filter((reservation) => inRange(arrivalDate(reservation), from, to)).length;
}

/**
 * Each guest's very first room-holding reservation — the one that makes them
 * a "new" guest. Ties on the same arrival date break by lowest id, so a guest
 * who booked two rooms for the same first night counts as new exactly once.
 */
function firstReservationIdByGuest(reservations) {
  const first = new Map();
  for (const reservation of holding(reservations)) {
    const key = String(reservation.guest_id);
    const current = first.get(key);
    const isEarlier =
      !current ||
      arrivalDate(reservation) < arrivalDate(current) ||
      (arrivalDate(reservation) === arrivalDate(current) && Number(reservation.id) < Number(current.id));
    if (isEarlier) first.set(key, reservation);
  }
  return new Set([...first.values()].map((reservation) => String(reservation.id)));
}

/** Guests whose first-ever stay arrives within [from, to]. */
export function countNewGuests(reservations, from, to) {
  const firsts = firstReservationIdByGuest(reservations);
  return holding(reservations).filter(
    (reservation) => firsts.has(String(reservation.id)) && inRange(arrivalDate(reservation), from, to)
  ).length;
}

/** Per business date: arrivals from first-time guests vs. guests with an earlier stay. */
export function newVsReturningByDay(reservations, dates) {
  const firsts = firstReservationIdByGuest(reservations);
  const byDate = new Map(dates.map((date) => [date, { date, newGuests: 0, returningGuests: 0 }]));
  for (const reservation of holding(reservations)) {
    const bucket = byDate.get(arrivalDate(reservation));
    if (!bucket) continue;
    if (firsts.has(String(reservation.id))) bucket.newGuests += 1;
    else bucket.returningGuests += 1;
  }
  return dates.map((date) => byDate.get(date));
}

/**
 * Whole-number percentages that always sum to exactly 100 (largest-remainder
 * method) — naive rounding can show a legend reading 33% + 33% + 33%.
 */
export function wholePercentages(counts) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((count) => (count / total) * 100);
  const floored = raw.map(Math.floor);
  let remaining = 100 - floored.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder);
  for (const { index } of order) {
    if (remaining <= 0) break;
    floored[index] += 1;
    remaining -= 1;
  }
  return floored;
}

export const MAX_DONUT_SEGMENTS = 4;

/** The calendar month containing a business date: its first and last day. */
export function monthRange(date) {
  const from = `${date.slice(0, 7)}-01`;
  const [year, month] = date.split('-').map(Number);
  const nextMonthFirst = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return { from, to: shiftDate(nextMonthFirst, -1) };
}

/**
 * Room-holding bookings grouped by room type, largest first — optionally
 * only those arriving within `range` ({from, to}, inclusive). The design has
 * exactly four segment colours, so beyond four types the smallest are folded
 * into one "Other" segment rather than inventing more colours.
 */
export function bookingsByRoomType(reservations, roomTypes, range) {
  const nameById = new Map((roomTypes ?? []).map((roomType) => [String(roomType.id), roomType.name]));
  const counts = new Map();
  for (const reservation of holding(reservations)) {
    if (range && !inRange(arrivalDate(reservation), range.from, range.to)) continue;
    const key = String(reservation.room_type_id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let segments = [...counts.entries()]
    .map(([id, count]) => ({ key: id, label: nameById.get(id) ?? `Room type ${id}`, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  if (segments.length > MAX_DONUT_SEGMENTS) {
    const kept = segments.slice(0, MAX_DONUT_SEGMENTS - 1);
    const otherCount = segments.slice(MAX_DONUT_SEGMENTS - 1).reduce((sum, segment) => sum + segment.count, 0);
    segments = [...kept, { key: 'other', label: 'Other', count: otherCount }];
  }

  const percents = wholePercentages(segments.map((segment) => segment.count));
  return segments.map((segment, index) => ({ ...segment, percent: percents[index] }));
}

/** An absolute change between two counts, e.g. "+3" / "−2". */
export function countDelta(current, previous) {
  const difference = current - previous;
  if (difference === 0) return { direction: 'flat', label: '0' };
  return { direction: difference > 0 ? 'up' : 'down', label: `${difference > 0 ? '+' : '−'}${Math.abs(difference)}` };
}

function cents(amount) {
  const [whole, fraction = ''] = String(amount ?? '0').replace('-', '').split('.');
  const value = Number(whole || '0') * 100 + Number(`${fraction}00`.slice(0, 2));
  return String(amount ?? '').startsWith('-') ? -value : value;
}

/** Percent change between two money amounts — `null` when there's no prior amount to compare against (a percent of zero is meaningless, never shown as a made-up "+100%"). */
export function moneyPercentDelta(current, previous) {
  const previousCents = cents(previous);
  if (previousCents === 0) return null;
  const change = Math.round(((cents(current) - previousCents) / Math.abs(previousCents)) * 100);
  if (change === 0) return { direction: 'flat', label: '0%' };
  return { direction: change > 0 ? 'up' : 'down', label: `${change > 0 ? '+' : '−'}${Math.abs(change)}%` };
}

export function totalMoney(amounts) {
  return sumMoney(amounts.map((amount) => amount ?? '0.00'));
}

export function isZeroMoney(amount) {
  return cents(amount) === 0;
}

/** Chart geometry only — see this file's own header. */
export function moneyToChartValue(amount) {
  return cents(amount) / 100;
}

/** A 0–1 ratio, clamped, or `null` when the denominator is zero. */
export function ratio(part, whole) {
  if (!whole) return null;
  return Math.min(Math.max(part / whole, 0), 1);
}

/** "Good morning/afternoon/evening" from the hour at the property's own timezone, falling back to the browser's when unset or invalid. */
export function greetingForHour(now, timeZone) {
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timeZone || undefined }).format(now));
  } catch {
    hour = now.getHours();
  }
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Thursday, 11 September" — the reference design's greeting subline. */
export function formatLongDate(now, timeZone) {
  const format = (zone) => {
    const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: zone }).formatToParts(now);
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('weekday')}, ${part('day')} ${part('month')}`;
  };
  try {
    return format(timeZone || undefined);
  } catch {
    return format(undefined);
  }
}

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon"/"Tue"… for a 'YYYY-MM-DD' business date — computed from the date's own digits, never the viewer's timezone. */
export function shortWeekday(date) {
  const [year, month, day] = date.split('-').map(Number);
  return SHORT_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}
