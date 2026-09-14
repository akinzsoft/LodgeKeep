'use strict';

/**
 * Staff-defined column mapping → normalised door events. Pure: no database,
 * no clock — every input (rows, rooms, timezone) is passed in, so each rule
 * here is directly unit-tested.
 *
 * Confirmed decisions this file implements:
 * - The app never assumes a column schema: staff map the file's REAL headers
 *   to room identifier, card id and timestamp (required), plus an optional
 *   card-type column and an optional grant/deny result column.
 * - Card type: staff tick which of the card-type column's real values mean
 *   "guest". Only guest-card events are evaluated by the rules. With no
 *   card-type column mapped, every event is treated as a guest card and the
 *   preview warns that staff/master opens will be misread.
 * - Result: staff tick which result values mean "denied". Denied opens are
 *   stored (a pattern of denied attempts is itself a future signal) but
 *   never evaluated — nobody got in.
 * - Timestamps: a real spreadsheet date cell needs no format; a text cell is
 *   read with the staff-chosen format (never auto-detected — a DD/MM file
 *   where every day is ≤ 12 reads silently wrong under guessing), then
 *   interpreted in the property's timezone and converted to UTC.
 * - Room matching: trimmed and case-insensitive against rooms.room_number,
 *   leading zeros ignored when both sides are all digits. Unmatched rows are
 *   excluded and reported with counts, never stored.
 */

const { ValidationError } = require('../../shared/errors');
const { zonedWallClockToUtc } = require('../../shared/timezone');

/** Text timestamp layouts offered on the mapping screen. Separators (/ - .) and an optional seconds/AM-PM part are accepted for each. */
const TIMESTAMP_FORMATS = Object.freeze({
  'DD/MM/YYYY HH:mm:ss': 'DMY',
  'MM/DD/YYYY HH:mm:ss': 'MDY',
  'YYYY-MM-DD HH:mm:ss': 'YMD',
});

const TEXT_TIMESTAMP = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
}

/**
 * Validates a submitted mapping against the uploaded file's own headers and
 * returns the normalised shape that is stored on `lock_system_config`.
 */
function normalizeMapping(input, headers) {
  const mapping = input && typeof input === 'object' ? input : {};
  const known = new Set(headers);
  const issues = [];

  const column = (field, { required }) => {
    const value = typeof mapping[field] === 'string' && mapping[field] !== '' ? mapping[field] : null;
    if (value === null) {
      if (required) issues.push({ field, issue: 'missing' });
      return null;
    }
    if (!known.has(value)) issues.push({ field, issue: 'not_a_column_in_this_file', value });
    return value;
  };

  const normalized = {
    roomColumn: column('roomColumn', { required: true }),
    cardColumn: column('cardColumn', { required: true }),
    timestampColumn: column('timestampColumn', { required: true }),
    timestampFormat: mapping.timestampFormat ?? null,
    cardTypeColumn: column('cardTypeColumn', { required: false }),
    guestCardTypeValues: asStringArray(mapping.guestCardTypeValues),
    resultColumn: column('resultColumn', { required: false }),
    deniedResultValues: asStringArray(mapping.deniedResultValues),
  };

  if (normalized.timestampFormat !== null && !TIMESTAMP_FORMATS[normalized.timestampFormat]) {
    issues.push({ field: 'timestampFormat', issue: 'unsupported', value: normalized.timestampFormat });
  }
  if (normalized.cardTypeColumn && normalized.guestCardTypeValues.length === 0) {
    issues.push({ field: 'guestCardTypeValues', issue: 'select_at_least_one_guest_value' });
  }
  if (!normalized.cardTypeColumn) normalized.guestCardTypeValues = [];
  if (!normalized.resultColumn) normalized.deniedResultValues = [];

  const requiredColumns = [normalized.roomColumn, normalized.cardColumn, normalized.timestampColumn].filter(Boolean);
  if (new Set(requiredColumns).size !== requiredColumns.length) {
    issues.push({ field: 'mapping', issue: 'room_card_and_timestamp_must_be_different_columns' });
  }

  if (issues.length) {
    throw new ValidationError('DOOR_ACCESS_MAPPING_INVALID', 'The column mapping is incomplete or does not match this file.', issues);
  }
  return normalized;
}

/** "0101" and "101" match; "B-12" matches "b-12". */
function normalizeRoomToken(value) {
  const text = String(value ?? '').trim();
  if (text === '') return '';
  return /^\d+$/.test(text) ? String(Number.parseInt(text, 10)) : text.toLowerCase();
}

/**
 * room_number → room, preferring an active room over an archived one when
 * two normalise to the same token (then the lowest id).
 */
function buildRoomIndex(rooms) {
  const index = new Map();
  const sorted = [...rooms].sort((a, b) => {
    const activeA = a.status === 'archived' ? 1 : 0;
    const activeB = b.status === 'archived' ? 1 : 0;
    return activeA - activeB || Number(a.id) - Number(b.id);
  });
  for (const room of sorted) {
    const token = normalizeRoomToken(room.room_number);
    if (token && !index.has(token)) index.set(token, room);
  }
  return index;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Wall-clock fields from a timestamp cell, or null when it cannot be read unambiguously. */
function parseTimestampCell(value, format) {
  if (value && typeof value === 'object' && value.kind === 'date') {
    const { year, month, day, hour, minute, second } = value;
    return { year, month, day, hour, minute, second };
  }
  if (typeof value !== 'string') return null;

  const order = format ? TIMESTAMP_FORMATS[format] : null;
  const match = TEXT_TIMESTAMP.exec(value.trim());
  if (!order || !match) return null;

  const [a, b, c] = [match[1], match[2], match[3]].map(Number);
  let year;
  let month;
  let day;
  if (order === 'YMD') [year, month, day] = [a, b, c];
  if (order === 'DMY') [day, month, year] = [a, b, c];
  if (order === 'MDY') [month, day, year] = [a, b, c];
  if (year < 1000) return null;

  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const meridiem = match[7]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

/**
 * Applies a normalised mapping to parsed rows.
 *
 * Returns candidate events (deduplicated within the file on the same natural
 * key the database enforces), rows that could not be parsed, and room
 * identifiers that matched no room — the three things the preview shows.
 */
/**
 * A lock audit trail is history: an event before 2000 (an unset lock clock
 * or an empty date cell read as the epoch) or more than a day in the future
 * is a misread or a mis-set clock, and must not become evidence.
 */
const EARLIEST_PLAUSIBLE = Date.UTC(2000, 0, 1);
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function extractEvents({ rows, mapping, roomIndex, timeZone, now = new Date() }) {
  const events = [];
  const unparseable = [];
  const unmatched = new Map();
  const seen = new Set();
  let duplicatesInFile = 0;

  const guestValues = new Set(mapping.guestCardTypeValues.map((v) => v.toLowerCase()));
  const deniedValues = new Set(mapping.deniedResultValues.map((v) => v.toLowerCase()));

  for (const row of rows) {
    const roomRaw = row.values[mapping.roomColumn];
    const cardRaw = row.values[mapping.cardColumn];
    const timestampRaw = row.values[mapping.timestampColumn];

    if (typeof roomRaw !== 'string' || typeof cardRaw !== 'string') {
      unparseable.push({ rowNumber: row.rowNumber, reason: 'missing_room_or_card' });
      continue;
    }
    if (cardRaw.length > 100) {
      unparseable.push({ rowNumber: row.rowNumber, reason: 'card_id_too_long' });
      continue;
    }

    const wallClock = parseTimestampCell(timestampRaw, mapping.timestampFormat);
    if (!wallClock) {
      unparseable.push({ rowNumber: row.rowNumber, reason: 'unreadable_timestamp', value: typeof timestampRaw === 'string' ? timestampRaw : null });
      continue;
    }

    const room = roomIndex.get(normalizeRoomToken(roomRaw));
    if (!room) {
      unmatched.set(roomRaw, (unmatched.get(roomRaw) ?? 0) + 1);
      continue;
    }

    const openedAt = zonedWallClockToUtc(wallClock, timeZone);
    if (openedAt.getTime() < EARLIEST_PLAUSIBLE || openedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      unparseable.push({ rowNumber: row.rowNumber, reason: 'implausible_timestamp', value: typeof timestampRaw === 'string' ? timestampRaw : null });
      continue;
    }
    const key = eventKey(room.id, cardRaw, openedAt);
    if (seen.has(key)) {
      duplicatesInFile += 1;
      continue;
    }
    seen.add(key);

    const cardTypeRaw = mapping.cardTypeColumn ? row.values[mapping.cardTypeColumn] : null;
    const cardType = typeof cardTypeRaw === 'string' ? cardTypeRaw : null;
    const resultRaw = mapping.resultColumn ? row.values[mapping.resultColumn] : null;

    events.push({
      rowNumber: row.rowNumber,
      roomId: room.id,
      roomNumber: room.room_number,
      cardId: cardRaw,
      cardType: cardType ? cardType.slice(0, 100) : null,
      isGuestCard: mapping.cardTypeColumn ? Boolean(cardType && guestValues.has(cardType.toLowerCase())) : true,
      result: typeof resultRaw === 'string' && deniedValues.has(resultRaw.toLowerCase()) ? 'denied' : 'granted',
      openedAt,
    });
  }

  events.sort((a, b) => a.openedAt - b.openedAt || a.rowNumber - b.rowNumber);

  return {
    events,
    unparseable,
    unmatchedRooms: [...unmatched.entries()].map(([identifier, count]) => ({ identifier, count })).sort((a, b) => b.count - a.count),
    duplicatesInFile,
  };
}

/**
 * The natural key the `door_access_events` unique index enforces. Card id is
 * compared case-insensitively because the column's utf8mb4_unicode_ci
 * collation does — a JS-side key that disagreed with the database would let
 * "ab12" and "AB12" both pass the pre-insert check and then collide.
 */
function eventKey(roomId, cardId, openedAt) {
  return `${String(roomId)}|${String(cardId).toLowerCase()}|${new Date(openedAt).getTime()}`;
}

module.exports = {
  TIMESTAMP_FORMATS,
  normalizeMapping,
  normalizeRoomToken,
  buildRoomIndex,
  parseTimestampCell,
  extractEvents,
  eventKey,
};
