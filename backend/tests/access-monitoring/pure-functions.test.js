'use strict';

/**
 * Pure-function coverage for door access monitoring (PLAN.md Phase 7): the
 * timezone conversion, SheetJS reading of real .xlsx/.xls/.csv bytes, and
 * the column-mapping layer. No database.
 */

const XLSX = require('xlsx');
const { zonedWallClockToUtc, calendarDateInZone } = require('../../src/shared/timezone');
const { readSpreadsheet, distinctValuesByHeader } = require('../../src/modules/access-monitoring/spreadsheet');
const {
  normalizeMapping,
  normalizeRoomToken,
  buildRoomIndex,
  parseTimestampCell,
  extractEvents,
  eventKey,
} = require('../../src/modules/access-monitoring/mapping');

describe('shared/timezone', () => {
  it('converts Lagos wall-clock time (UTC+1, no DST) to the UTC instant', () => {
    expect(zonedWallClockToUtc({ year: 2026, month: 3, day: 4, hour: 23, minute: 5, second: 9 }, 'Africa/Lagos').toISOString()).toBe('2026-03-04T22:05:09.000Z');
  });

  it('crosses a date boundary correctly for a far-east zone', () => {
    expect(zonedWallClockToUtc({ year: 2026, month: 1, day: 1, hour: 5, minute: 0 }, 'Pacific/Kiritimati').toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('uses the summer offset on a DST date (London BST, UTC+1)', () => {
    expect(zonedWallClockToUtc({ year: 2026, month: 7, day: 1, hour: 12, minute: 0 }, 'Europe/London').toISOString()).toBe('2026-07-01T11:00:00.000Z');
    expect(zonedWallClockToUtc({ year: 2026, month: 1, day: 1, hour: 12, minute: 0 }, 'Europe/London').toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  it('reads the calendar date an instant falls on in the zone, not in UTC', () => {
    expect(calendarDateInZone(new Date('2026-03-04T23:30:00Z'), 'Africa/Lagos')).toBe('2026-03-05');
    expect(calendarDateInZone(new Date('2026-03-04T23:30:00Z'), 'UTC')).toBe('2026-03-04');
  });
});

function workbookBuffer(rows, bookType, { dateFormat } = {}) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (dateFormat) {
    for (const address of Object.keys(sheet)) {
      if (sheet[address]?.t === 'n' && address.startsWith('C') && address !== 'C1') sheet[address].z = dateFormat;
    }
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Audit');
  return XLSX.write(book, { type: 'buffer', bookType });
}

describe('spreadsheet reading', () => {
  it.each(['xlsx', 'biff8'])('reads real %s date cells as their displayed calendar fields', (bookType) => {
    const serial = 25569 + Date.UTC(2026, 2, 4, 23, 5, 9) / 86400000; // Excel serial for 2026-03-04 23:05:09
    const buffer = workbookBuffer([['Door', 'Card No', 'Time'], [101, 'A1B2', serial]], bookType, { dateFormat: 'dd/mm/yyyy hh:mm:ss' });
    const { headers, rows } = readSpreadsheet(buffer);
    expect(headers).toEqual(['Door', 'Card No', 'Time']);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowNumber).toBe(2);
    expect(rows[0].values.Door).toBe('101');
    expect(rows[0].values.Time).toMatchObject({ kind: 'date', year: 2026, month: 3, day: 4, hour: 23, minute: 5, second: 9 });
  });

  it('keeps a zero-padded numeric card id ("0042") distinct from "42" — the displayed text wins (code-review regression)', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Door', 'Card'], [101, 42], [102, 42]]);
    sheet.B2.z = '0000';
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Audit');
    const { rows } = readSpreadsheet(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    expect(rows.map((r) => r.values.Card)).toEqual(['0042', '42']);
  });

  it('keeps CSV text verbatim — a DD/MM date is never guessed as US month-first', () => {
    const { rows } = readSpreadsheet(Buffer.from('Room,Card,When\n0101,C1,03/04/2026 23:05\n'));
    expect(rows[0].values).toEqual({ Room: '0101', Card: 'C1', When: '03/04/2026 23:05' });
  });

  it('names blank headers, disambiguates duplicates and skips blank rows', () => {
    const { headers, rows } = readSpreadsheet(Buffer.from('Room,,Room\n1,x,2\n,,\n3,y,4\n'));
    expect(headers).toEqual(['Room', 'Column 2', 'Room (2)']);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it('rejects an empty upload', () => {
    expect(() => readSpreadsheet(Buffer.alloc(0))).toThrow(expect.objectContaining({ code: 'VALIDATION_DOOR_ACCESS_FILE_EMPTY' }));
  });

  it('lists distinct text values per column for the mapping tick boxes', () => {
    const { headers, rows } = readSpreadsheet(Buffer.from('Type\nGuest\nMaster\nGuest\n'));
    expect(distinctValuesByHeader(headers, rows).Type).toEqual({ values: ['Guest', 'Master'], truncated: false });
  });
});

describe('mapping', () => {
  const headers = ['Room', 'Card', 'When', 'Type', 'Result'];

  it('requires room, card and timestamp columns that exist in this file', () => {
    expect(() => normalizeMapping({ roomColumn: 'Room', cardColumn: 'Nope' }, headers)).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_DOOR_ACCESS_MAPPING_INVALID',
        details: expect.arrayContaining([
          { field: 'cardColumn', issue: 'not_a_column_in_this_file', value: 'Nope' },
          { field: 'timestampColumn', issue: 'missing' },
        ]),
      })
    );
  });

  it('requires at least one guest value once a card-type column is mapped', () => {
    expect(() => normalizeMapping({ roomColumn: 'Room', cardColumn: 'Card', timestampColumn: 'When', timestampFormat: 'DD/MM/YYYY HH:mm:ss', cardTypeColumn: 'Type' }, headers)).toThrow(
      expect.objectContaining({ details: [{ field: 'guestCardTypeValues', issue: 'select_at_least_one_guest_value' }] })
    );
  });

  it('rejects mapping two required fields to the same column', () => {
    expect(() => normalizeMapping({ roomColumn: 'Room', cardColumn: 'Room', timestampColumn: 'When' }, headers)).toThrow(
      expect.objectContaining({ details: [{ field: 'mapping', issue: 'room_card_and_timestamp_must_be_different_columns' }] })
    );
  });

  it('normalises room tokens: leading zeros ignored for digits, case ignored otherwise', () => {
    expect(normalizeRoomToken(' 0101 ')).toBe('101');
    expect(normalizeRoomToken('B-12')).toBe('b-12');
    const index = buildRoomIndex([
      { id: 2, room_number: '101', status: 'archived' },
      { id: 3, room_number: '0101', status: 'active' },
    ]);
    expect(index.get('101').id).toBe(3); // active beats archived on a collision
  });

  it('reads text timestamps only in the chosen format, validating the calendar', () => {
    expect(parseTimestampCell('03/04/2026 23:05', 'DD/MM/YYYY HH:mm:ss')).toEqual({ year: 2026, month: 4, day: 3, hour: 23, minute: 5, second: 0 });
    expect(parseTimestampCell('03/04/2026 23:05', 'MM/DD/YYYY HH:mm:ss')).toEqual({ year: 2026, month: 3, day: 4, hour: 23, minute: 5, second: 0 });
    expect(parseTimestampCell('2026-04-03 11:05:30 PM', 'YYYY-MM-DD HH:mm:ss')).toEqual({ year: 2026, month: 4, day: 3, hour: 23, minute: 5, second: 30 });
    expect(parseTimestampCell('31/02/2026 10:00', 'DD/MM/YYYY HH:mm:ss')).toBeNull();
    expect(parseTimestampCell('03/04/2026 23:05', null)).toBeNull(); // text never guessed
    expect(parseTimestampCell('03/04/2026', 'DD/MM/YYYY HH:mm:ss')).toBeNull(); // no time → not a door event
  });

  it('extracts events: guest/denied interpretation, unmatched rooms, unparseable rows, in-file duplicates', () => {
    const mapping = normalizeMapping(
      {
        roomColumn: 'Room',
        cardColumn: 'Card',
        timestampColumn: 'When',
        timestampFormat: 'DD/MM/YYYY HH:mm:ss',
        cardTypeColumn: 'Type',
        guestCardTypeValues: ['Guest'],
        resultColumn: 'Result',
        deniedResultValues: ['Denied'],
      },
      headers
    );
    const rows = [
      { rowNumber: 2, values: { Room: '0101', Card: 'C1', When: '04/03/2026 23:05:00', Type: 'GUEST', Result: 'OK' } },
      { rowNumber: 3, values: { Room: '101', Card: 'c1', When: '04/03/2026 23:05:00', Type: 'Guest', Result: 'OK' } }, // same event, card case differs
      { rowNumber: 4, values: { Room: '101', Card: 'M9', When: '04/03/2026 22:00:00', Type: 'Master', Result: 'Denied' } },
      { rowNumber: 5, values: { Room: '999', Card: 'C1', When: '04/03/2026 23:05:00', Type: 'Guest', Result: 'OK' } },
      { rowNumber: 6, values: { Room: '101', Card: 'C1', When: 'yesterday', Type: 'Guest', Result: 'OK' } },
    ];
    const result = extractEvents({ rows, mapping, roomIndex: buildRoomIndex([{ id: 7, room_number: '101', status: 'active' }]), timeZone: 'Africa/Lagos' });

    expect(result.duplicatesInFile).toBe(1);
    expect(result.unmatchedRooms).toEqual([{ identifier: '999', count: 1 }]);
    expect(result.unparseable).toEqual([{ rowNumber: 6, reason: 'unreadable_timestamp', value: 'yesterday' }]);
    expect(result.events.map((e) => [e.rowNumber, e.isGuestCard, e.result, e.openedAt.toISOString()])).toEqual([
      [4, false, 'denied', '2026-03-04T21:00:00.000Z'], // sorted by occurrence
      [2, true, 'granted', '2026-03-04T22:05:00.000Z'],
    ]);
  });

  it('rejects implausible timestamps — before 2000 or more than a day in the future (code-review regression)', () => {
    const mapping = normalizeMapping({ roomColumn: 'Room', cardColumn: 'Card', timestampColumn: 'When', timestampFormat: 'YYYY-MM-DD HH:mm:ss' }, headers);
    const now = new Date('2026-09-13T12:00:00Z');
    const result = extractEvents({
      rows: [
        { rowNumber: 2, values: { Room: '101', Card: 'A', When: '1970-01-01 00:00:00' } },
        { rowNumber: 3, values: { Room: '101', Card: 'A', When: '2026-09-16 10:00:00' } },
        { rowNumber: 4, values: { Room: '101', Card: 'A', When: '2026-09-14 10:00:00' } },
      ],
      mapping,
      roomIndex: buildRoomIndex([{ id: 7, room_number: '101', status: 'active' }]),
      timeZone: 'UTC',
      now,
    });
    expect(result.unparseable.map((u) => [u.rowNumber, u.reason])).toEqual([
      [2, 'implausible_timestamp'],
      [3, 'implausible_timestamp'],
    ]);
    expect(result.events.map((e) => e.rowNumber)).toEqual([4]); // within the one-day clock-skew tolerance
  });

  it('treats every event as a guest card when no card-type column is mapped', () => {
    const mapping = normalizeMapping({ roomColumn: 'Room', cardColumn: 'Card', timestampColumn: 'When', timestampFormat: 'DD/MM/YYYY HH:mm:ss', guestCardTypeValues: ['ignored'] }, headers);
    expect(mapping.guestCardTypeValues).toEqual([]);
    const { events } = extractEvents({
      rows: [{ rowNumber: 2, values: { Room: '101', Card: 'S1', When: '04/03/2026 10:00' } }],
      mapping,
      roomIndex: buildRoomIndex([{ id: 7, room_number: '101', status: 'active' }]),
      timeZone: 'UTC',
    });
    expect(events[0].isGuestCard).toBe(true);
  });

  it('builds the same natural key the database enforces (card case-insensitive)', () => {
    expect(eventKey(7, 'AB12', '2026-03-04T22:05:00Z')).toBe(eventKey('7', 'ab12', new Date('2026-03-04T22:05:00Z')));
  });
});
