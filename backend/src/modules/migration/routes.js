'use strict';

/**
 * Route wiring for data migration — PLAN.md Phase 5's last unbuilt bullet,
 * PRODUCT_REQUIREMENTS.md §3.20 ("Admin only, and typically used once").
 * Mounted as an ordinary business router in `src/app.js` (no special
 * ordering need like offboarding/impersonation — a migration run never
 * needs to survive a read-only tenant-lifecycle state or an impersonation
 * grant the way "end my own session" or "check my own export status"
 * does).
 *
 * `multer` is this codebase's first file-upload dependency — disk storage
 * into `IMPORT_STORAGE_DIR` (`storage.js`, gitignored, mirroring
 * `EXPORT_STORAGE_DIR`'s own precedent), a random filename (never the
 * client-supplied `originalname` — that's stored separately in
 * `import_runs.original_filename` for display, never used as a path
 * component). A 20MB cap — generous for a spreadsheet-shaped CSV, small
 * enough that an accidental multi-gigabyte upload can't exhaust disk.
 */

const crypto = require('crypto');
const { Router } = require('express');
const multer = require('multer');
const controller = require('./controller');
const { requirePermission } = require('../../auth');
const { storageDir } = require('./storage');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storageDir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}.csv`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function migrationRouter() {
  const router = Router();

  router.get('/migration/templates/:entityType', requirePermission('migration.manage'), controller.downloadTemplate);

  router.post('/migration/imports', requirePermission('migration.manage'), upload.single('file'), controller.uploadImport);
  router.get('/migration/imports', requirePermission('migration.manage'), controller.listRuns);
  router.get('/migration/imports/:id', requirePermission('migration.manage'), controller.getRun);
  router.post('/migration/imports/:id/dry-run', requirePermission('migration.manage'), controller.dryRun);
  router.patch('/migration/imports/:id/duplicates/:rowNumber', requirePermission('migration.manage'), controller.resolveDuplicate);
  router.post('/migration/imports/:id/commit', requirePermission('migration.manage'), controller.commit);
  router.post('/migration/imports/:id/rollback', requirePermission('migration.manage'), controller.rollback);

  return router;
}

module.exports = { migrationRouter };
