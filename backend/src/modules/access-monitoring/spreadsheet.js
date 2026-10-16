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
const MAX_COLUMNS = 100;
/** The route's multer cap uses this too: a lock export of 50,000 rows is a few MB, so this is generous. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1000;

/** Total size an .xlsx may expand to once unzipped (`DOOR_ACCESS_MAX_UNZIPPED_BYTES`; a garbage value falls back to the default). */
function maxUnzippedBytes() {
  const raw = process.env.DOOR_ACCESS_MAX_UNZIPPED_BYTES;
  return typeof raw === 'string' && /^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : DEFAULT_MAX_UNZIPPED_BYTES;
}

const tooLarge = (message) => new ValidationError('DOOR_ACCESS_FILE_TOO_LARGE', message);

/**
 * A zip bomb is a tiny file that unzips to gigabytes, and SheetJS inflates the whole archive before any row limit can
 * apply. So an .xlsx (a zip: "PK" signature) has its central directory read first and is refused when the sizes it
 * DECLARES add up to more than the cap, when it has too many entries, or when it uses ZIP64 (not needed for a lock
 * export). Declared sizes are what the archive claims; this is a cheap first gate, not a substitute for the upload cap
 * and the row cap. A buffer that is not a readable zip is left for the parser to report as unreadable.
 */
function assertSafeArchive(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return;
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return;
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) throw tooLarge('That workbook uses an archive format that is too large for an import.');
  if (entries > MAX_ZIP_ENTRIES) throw tooLarge(`That workbook has too many parts (limit ${MAX_ZIP_ENTRIES}).`);
  const cap = maxUnzippedBytes();
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return; // damaged directory: the parser reports it
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) throw tooLarge('That workbook uses an archive format that is too large for an import.');
    total += size;
    if (total > cap) throw tooLarge('That workbook expands to more data than one import allows. Export a shorter date range.');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
}

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

  assertSafeArchive(buffer);

  let workbook;
  try {
    // `sheetRows` makes SheetJS stop after the row cap (+ header + one to detect an overflow) instead of parsing the whole sheet.
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellNF: true, dense: false, sheetRows: MAX_ROWS + 2 });
  } catch {
    throw new ValidationError('DOOR_ACCESS_FILE_UNREADABLE', 'The uploaded file could not be read as a spreadsheet (.xls, .xlsx or .csv).');
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet || !sheet['!ref']) {
    throw new ValidationError('DOOR_ACCESS_FILE_EMPTY', 'The uploaded file has no rows.');
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (range.e.c - range.s.c + 1 > MAX_COLUMNS) {
    throw tooLarge(`A single import is limited to ${MAX_COLUMNS} columns.`);
  }
  const cellAt = (r, c) => sheet[XLSX.utils.encode_cell({ r, c })];

  const rawHeaders = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) rawHeaders.push(cellValue(cellAt(range.s.r, c)));
  if (rawHeaders.every((h) => h === null)) {
    throw new ValidationError('DOOR_ACCESS_FILE_NO_HEADERS', 'The first row of the file must contain column headers.');
  }
  const headers = uniqueHeaders(rawHeaders.map((h) => (h && typeof h === 'object' ? null : h)));

  if (range.e.r - range.s.r > MAX_ROWS) {
    throw tooLarge(`A single import is limited to ${MAX_ROWS} rows.`);
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

module.exports = { readSpreadsheet, distinctValuesByHeader, MAX_ROWS, MAX_UPLOAD_BYTES };
