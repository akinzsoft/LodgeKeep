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

const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

function storageDir() {
  const dir = process.env.IMPORT_STORAGE_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'imports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The CSV upload middleware both import routers use (Data Migration and the
 * supermarket product import): disk storage under `storageDir()`, a random
 * file name (never the client's), a 20 MB cap.
 */
const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storageDir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}.csv`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

module.exports = { storageDir, csvUpload };
