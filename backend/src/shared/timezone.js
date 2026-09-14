'use strict';

/**
 * Wall-clock ↔ UTC conversion against an IANA timezone, using only `Intl`
 * (no date-tz library exists in this codebase, and none is needed for this).
 *
 * First real reader of `properties.timezone` (PLAN.md Phase 7): a lock
 * system's audit trail records local wall-clock times with no offset, and
 * every PMS instant it is compared against (`reservation_rooms`,
 * `checked_in_at`/`checked_out_at`) is a true UTC instant (knexfile.js pins
 * the connection to UTC). Converting at import is what makes the two
 * comparable. Promoted to shared/ from the start because Night Audit's own
 * business-date boundaries will need exactly this.
 *
 * DST: a wall-clock time that is ambiguous (the repeated hour when clocks go
 * back) resolves to the earlier offset; a nonexistent one (the skipped hour)
 * resolves as if the pre-transition offset still applied. Both are at most a
 * one-hour skew on a handful of nights a year in markets that observe DST —
 * documented rather than silently accepted.
 */

const formatterCache = new Map();

function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    );
  }
  return formatterCache.get(timeZone);
}

/** The wall-clock fields `instant` shows in `timeZone`. */
function wallClockParts(instant, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(instant)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function offsetMillisAt(instantMillis, timeZone) {
  const p = wallClockParts(new Date(instantMillis), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMillis;
}

/**
 * Interprets `{year, month, day, hour, minute, second}` as wall-clock time in
 * `timeZone` and returns the true UTC instant. Two correction passes so a
 * guess that straddles a DST boundary settles on the right offset.
 */
function zonedWallClockToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = asIfUtc - offsetMillisAt(asIfUtc, timeZone);
  instant = asIfUtc - offsetMillisAt(instant, timeZone);
  return new Date(instant);
}

/** The calendar date ("YYYY-MM-DD") `instant` falls on in `timeZone`. */
function calendarDateInZone(instant, timeZone) {
  const p = wallClockParts(instant, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

module.exports = { zonedWallClockToUtc, calendarDateInZone };
