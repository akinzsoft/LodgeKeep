'use strict';

/**
 * Local-disk, gitignored upload storage for data-migration CSV files —
 * `IMPORT_STORAGE_DIR`, mirroring `tenant-data-export.js`'s own
 * `EXPORT_STORAGE_DIR` precedent exactly (no object-storage dependency
 * exists in this codebase; none is added for this pass). Shared by
 * `controller.js` (multer's disk-storage destination) and
 * `src/jobs/data-import.js` (re-reading the file fresh for the commit job,
 * the same "re-parse from disk, don't cache" discipline `parse.js` uses).
 */

const fs = require('fs');
const path = require('path');

function storageDir() {
  const dir = process.env.IMPORT_STORAGE_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'imports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { storageDir };
