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
  const records = parse(raw, { columns: true, trim: true, skip_empty_lines: true, bom: true });
  return records.map((row, index) => ({ ...row, __rowNumber: index + 1 }));
}

module.exports = { parseImportFile };
