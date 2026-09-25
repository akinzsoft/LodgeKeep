'use strict';

/**
 * The files a tenant owns on local disk, deleted by the retention purge —
 * BEFORE the rows that reference them, so a crash between the two leaves rows
 * pointing at missing files (harmless) rather than files no row points at
 * (a customer's data on disk forever, and for logos and menu photos, on a public
 * unauthenticated URL).
 *
 * Four storage kinds exist (`grep *_STORAGE_DIR`): exports, imports, menu
 * images, property logos. Every path taken from a database row is resolved and
 * required to sit INSIDE its configured directory before it is unlinked: a row
 * value is data, and a purge must never be a way to delete an arbitrary file.
 */

const fs = require('fs');
const path = require('path');
const { removeImageStrict, fileNameFromUrl } = require('../../shared/image-store');
const { storageDir: exportStorageDir } = require('../../jobs/tenant-data-export');
const { storageDir: importStorageDir } = require('../migration/storage');

/** True only when `target` resolves to a path strictly inside `dir`. */
function isInside(dir, target) {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Removes one file if it lies inside `dir`. `'deleted'` | `'missing'` | `'unsafe'` (outside `dir`, left alone). Throws on any other I/O error. */
function removeInside(dir, filePath) {
  if (!filePath) return 'missing';
  if (!isInside(dir, filePath)) return 'unsafe';
  try {
    fs.rmSync(path.resolve(filePath));
    return 'deleted';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** A tally shaped `{deleted, missing, unsafe}`. */
function emptyTally() {
  return { deleted: 0, missing: 0, unsafe: 0 };
}

function record(tally, outcome) {
  tally[outcome] += 1;
}

/**
 * Deletes the files owned by a chunk of rows of one hooked table. `rows` carry the
 * hook's column. Returns the tally for THIS chunk.
 */
function deleteFilesForRows(hook, rows) {
  const tally = emptyTally();
  for (const row of rows) {
    if (hook.kind === 'menu_image') {
      record(tally, removeImageStrict('menu-items', row[hook.column]) ? 'deleted' : 'missing');
    } else if (hook.kind === 'property_logo') {
      const fileName = fileNameFromUrl('property-logos', row[hook.column]);
      record(tally, fileName && removeImageStrict('property-logos', fileName) ? 'deleted' : 'missing');
    } else if (hook.kind === 'import_file') {
      record(tally, removeInside(importStorageDir(), row[hook.column]));
    } else {
      throw new Error(`purge-files: unknown file hook kind "${hook.kind}".`);
    }
  }
  return tally;
}

/**
 * Deletes every export file this tenant has: each row's `file_path`, plus any file
 * named `tenant-<id>-export-<n>.json` in the directory (an orphan an export job wrote
 * whose row was later failed). The trailing `-export-<digits>.json` anchors the
 * match, so tenant 12's purge can never touch tenant 123's files.
 */
function deleteExportFilesForTenant({ tenantId, rows }) {
  const dir = exportStorageDir();
  const tally = emptyTally();
  const seen = new Set();

  for (const row of rows) {
    if (!row.file_path) continue;
    seen.add(path.resolve(row.file_path));
    record(tally, removeInside(dir, row.file_path));
  }

  const pattern = new RegExp(`^tenant-${String(tenantId).replace(/[^0-9]/g, '')}-export-\\d+\\.json$`);
  for (const name of fs.readdirSync(dir)) {
    if (!pattern.test(name)) continue;
    const full = path.join(dir, name);
    if (seen.has(path.resolve(full))) continue;
    record(tally, removeInside(dir, full));
  }
  return tally;
}

function addTallies(a, b) {
  return { deleted: a.deleted + b.deleted, missing: a.missing + b.missing, unsafe: a.unsafe + b.unsafe };
}

module.exports = { isInside, removeInside, deleteFilesForRows, deleteExportFilesForTenant, emptyTally, addTallies };
