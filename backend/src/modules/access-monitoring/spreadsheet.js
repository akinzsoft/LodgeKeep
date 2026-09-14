'use strict';

/**
 * The `manual_import` ingestion seam — PRODUCT_REQUIREMENTS.md §3.23's
 * "thin adapter per lock vendor/mode behind one internal interface".
 *
 * Reads an uploaded lock audit-trail export (.xls, .xlsx or .csv — SheetJS
 * handles all three, confirmed decision) into header-keyed rows of plain
 * cell values. Knows nothing about rooms, reservations or rules; the rules
 * engine never imports this file, so a future webhook/polling adapter can
 * produce the same normalised event shape (`mapping.js`'s output) without
 * touching detection.
 *
 * Why a generic column-mapping reader rather than a hardcoded HiRead ProUSB
 * schema: ProUSB's literal export columns could not be confirmed, and the
 * same reader serves any other vendor's export (`generic_csv`).
 *
 * Parsing choices, each deliberate:
 * - `raw: true` — CSV text is kept verbatim. Without it SheetJS guesses
 *   dates in CSV cells using US month-first order, silently misreading a
 *   DD/MM file; the staff-chosen timestamp format decides instead.
 * - `cellNF: true` — keeps each cell's number format so a genuine Excel
 *   date cell (a serial number with a date format) is recognised and
 *   decoded to its displayed calendar fields with no timezone involved.
 * - Only the first worksheet is read.
 */

const XLSX = require('xlsx');
const { ValidationError } = require('../../shared/errors');

const MAX_ROWS = 50000;

/** A cell as the mapping layer consumes it: a trimmed string, or decoded date fields for a real date cell. */
function cellValue(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return null;

  if (cell.t === 'd' && cell.v instanceof Date) {
    const d = cell.v;
    return { kind: 'date', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
  }

  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
    const code = XLSX.SSF.parse_date_code(cell.v);
    if (code) return { kind: 'date', year: code.y, month: code.m, day: code.d, hour: code.H, minute: code.M, second: code.S };
  }

  if (cell.t === 'n') {
    // A numeric card id or room number. A zero-padding format ("0000") is
    // part of the identifier as staff see it — card "0042" and card "42"
    // must not become the same card — so the displayed text wins. Otherwise
    // the exact integer, or the displayed text for a non-integer.
    if (cell.w && typeof cell.z === 'string' && /^0+$/.test(cell.z)) return String(cell.w).trim();
    if (Number.isSafeInteger(cell.v)) return String(cell.v);
    return String(cell.w ?? cell.v).trim();
  }

  const text = String(cell.w ?? cell.v).trim();
  return text === '' ? null : text;
}

function uniqueHeaders(rawHeaders) {
  const seen = new Map();
  return rawHeaders.map((raw, index) => {
    const base = raw && typeof raw === 'string' ? raw : raw ? String(raw) : `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/**
 * `{ headers: string[], rows: [{ rowNumber, values: {header: value} }] }`.
 * Row 1 is the header row; `rowNumber` is the spreadsheet's own 1-based row
 * so staff can find a rejected row in the file they uploaded.
 */
function readSpreadsheet(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new ValidationError('DOOR_ACCESS_FILE_EMPTY', 'The uploaded file is empty.');
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellNF: true, dense: false });
  } catch {
    throw new ValidationError('DOOR_ACCESS_FILE_UNREADABLE', 'The uploaded file could not be read as a spreadsheet (.xls, .xlsx or .csv).');
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet || !sheet['!ref']) {
    throw new ValidationError('DOOR_ACCESS_FILE_EMPTY', 'The uploaded file has no rows.');
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const cellAt = (r, c) => sheet[XLSX.utils.encode_cell({ r, c })];

  const rawHeaders = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) rawHeaders.push(cellValue(cellAt(range.s.r, c)));
  if (rawHeaders.every((h) => h === null)) {
    throw new ValidationError('DOOR_ACCESS_FILE_NO_HEADERS', 'The first row of the file must contain column headers.');
  }
  const headers = uniqueHeaders(rawHeaders.map((h) => (h && typeof h === 'object' ? null : h)));

  if (range.e.r - range.s.r > MAX_ROWS) {
    throw new ValidationError('DOOR_ACCESS_FILE_TOO_LARGE', `A single import is limited to ${MAX_ROWS} rows.`);
  }

  const rows = [];
  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const values = {};
    let empty = true;
    headers.forEach((header, offset) => {
      const value = cellValue(cellAt(r, range.s.c + offset));
      values[header] = value;
      if (value !== null) empty = false;
    });
    if (!empty) rows.push({ rowNumber: r + 1, values });
  }

  return { headers, rows };
}

/** Up to `limit` distinct non-empty text values per header — what the mapping screen offers as "which of these mean guest/denied" tick boxes. */
function distinctValuesByHeader(headers, rows, limit = 25) {
  const result = {};
  for (const header of headers) {
    const values = new Set();
    for (const row of rows) {
      const value = row.values[header];
      if (typeof value === 'string') values.add(value);
      if (values.size > limit) break;
    }
    result[header] = { values: [...values].slice(0, limit).sort(), truncated: values.size > limit };
  }
  return result;
}

module.exports = { readSpreadsheet, distinctValuesByHeader, MAX_ROWS };
