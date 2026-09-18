'use strict';

/**
 * CSV parsing — the one place `csv-parse` is required. RFC4180-correct
 * (embedded commas/quotes/newlines in a real spreadsheet export are exactly
 * the "bad data poisons everything downstream" risk PRODUCT_REQUIREMENTS.md
 * §3.20 names), not a hand-rolled `.split(',')`.
 *
 * Re-read fresh from disk on every call (dry run, and again by the commit
 * job) rather than cached anywhere — the file on `IMPORT_STORAGE_DIR` is
 * the one source of truth for "what was actually uploaded," and re-parsing
 * it is cheap relative to the database work either caller does around it.
 */

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { UnsafeCsvHeaderError, TooManyImportColumnsError, TooManyImportRowsError, MalformedCsvError } = require('./errors');

/**
 * `csv-parse` before 7.0.2 could let a `__proto__`/`constructor`/`prototype`
 * header pollute the prototype of every constructed row object
 * (GHSA-8cw4-87c7-c6xx) — fixed upstream by the pinned `^7.0.2` dependency,
 * but rejected here too, as defense-in-depth against a future downgrade or
 * a similar bug in whatever parses this header row next.
 */
const RESERVED_COLUMN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Security-review finding: `multer`'s own 20MB upload cap (`routes.js`)
 * bounds the file on disk, but nothing bounded the SHAPE of what's inside
 * it — a 20MB file can still be one pathologically wide row (millions of
 * columns) or hundreds of thousands of tiny ones, either of which builds a
 * correspondingly huge in-memory array of row objects during this
 * synchronous parse (§3.20's own confirmed "dry run is synchronous, not
 * job-based" design — see this module's own header/CLAUDE.md — a bigger
 * architecture change than this hardening pass warrants). Real, generous
 * ceilings for every migration entity type this module actually supports
 * (guests/reservations/companies/ar_balances — all well under 10 columns,
 * and no real hotel's one-off migration needs six-figure row counts).
 * `MAX_RECORD_CHARS` tightens `csv-parse`'s own already-real (if
 * undocumented) `max_record_size` default of 128,000 characters — a single
 * CSV field/record in this schema is never remotely that large.
 */
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 200;
const MAX_RECORD_CHARS = 20_000;

/**
 * Returns `{ header, rows }` — `rows` is an array of plain objects keyed by
 * the CSV's own header row (whatever it actually says, not the template's
 * expected columns — a missing/misnamed column surfaces as `undefined`
 * values the validators below catch, rather than a parse-time crash).
 * 1-based `rowNumber` (data rows only, header excluded) is attached to each
 * row as a non-enumerable-adjacent plain field for convenience.
 */
function parseImportFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const [headerRow] = safeParse(raw, { columns: false, trim: true, bom: true, to: 1, max_record_size: MAX_RECORD_CHARS });
  assertSafeHeaderRow(headerRow || []);
  assertColumnCount(headerRow || []);
  // `to: MAX_ROWS + 1` stops the parser itself the moment an oversized file
  // would exceed the cap, rather than fully parsing a huge file into memory
  // only to reject it afterward — the actual point of a row-count ceiling.
  const records = safeParse(raw, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    bom: true,
    to: MAX_ROWS + 1,
    max_record_size: MAX_RECORD_CHARS,
  });
  assertRowCount(records);
  return records.map((row, index) => ({ ...row, __rowNumber: index + 1 }));
}

/**
 * A real, pre-existing gap this hardening pass found and fixed, not
 * introduced by it — see `MalformedCsvError`'s own header in `errors.js`.
 */
function safeParse(raw, options) {
  try {
    return parse(raw, options);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('CSV_')) {
      throw new MalformedCsvError(error.code);
    }
    throw error;
  }
}

function assertSafeHeaderRow(headerRow) {
  const unsafe = headerRow.filter((name) => RESERVED_COLUMN_NAMES.has(String(name).trim().toLowerCase()));
  if (unsafe.length > 0) {
    throw new UnsafeCsvHeaderError(unsafe);
  }
}

function assertColumnCount(headerRow) {
  if (headerRow.length > MAX_COLUMNS) {
    throw new TooManyImportColumnsError(headerRow.length, MAX_COLUMNS);
  }
}

function assertRowCount(records) {
  if (records.length > MAX_ROWS) {
    throw new TooManyImportRowsError(MAX_ROWS);
  }
}

module.exports = { parseImportFile };
