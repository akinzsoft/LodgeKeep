'use strict';

/**
 * HTTP layer for the Stage 3 product import (/supermarket/imports). Every
 * route needs `supermarket.manage` (routes.js) and the run's outlet must be
 * an active supermarket the caller is assigned to (`requireSupermarketOutlet`).
 * The run lifecycle itself is the Data Migration service's, called with
 * `viaSupermarket`; the product rules are `product-import.js`.
 *
 * Like the Data Migration controller, no `runIdempotentMutation`: uploading
 * twice is meant to create two runs, the dry run is re-runnable, and commit
 * and undo are each a guarded status transition with nothing to replay.
 */

const fs = require('fs');
const { ok, notFound } = require('../../shared/response');
const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const migrationService = require('../migration/service');
const { MissingUploadedFileError } = require('../migration/errors');
const { requireSupermarketOutlet } = require('./service');
const productImport = require('./product-import');

function require_(source, field) {
  const value = source?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

/** The product run named in the URL, as long as it belongs to the caller's active property and an outlet they may manage — else null (404). */
async function loadRun(req) {
  const found = await migrationService.getImportRun({ context: req.context, importRunId: req.params.id });
  if (!found || found.run.entity_type !== productImport.ENTITY_TYPE) return null;
  if (String(found.run.property_id) !== String(req.context.propertyId)) return null;
  await requireSupermarketOutlet({ db: scopedDb().for(req.context), context: req.context, outletId: found.run.outlet_id });
  return found;
}

/** A run with at most a few hundred findings of each kind (and their full counts), plus its summary when asked. */
async function present(req, found, { summary } = {}) {
  return {
    run: found.run,
    ...productImport.limitFindings(found.errors ?? []),
    summary: summary ?? (await productImport.summarizeRun({ context: req.context, run: found.run })),
  };
}

function downloadTemplate(req, res) {
  res.status(200).set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="supermarket-products-template.csv"').send(productImport.templateCsv());
}

async function listImports(req, res, next) {
  try {
    const outletId = require_(req.query, 'outlet_id');
    await requireSupermarketOutlet({ db: scopedDb().for(req.context), context: req.context, outletId });
    res.json(ok(await migrationService.listImportRuns({ context: req.context, entityType: productImport.ENTITY_TYPE, outletId })));
  } catch (error) {
    next(error);
  }
}

/** Upload, then the dry run straight away. A file that is not the template is refused before any run exists. */
async function uploadImport(req, res, next) {
  const filePath = req.file?.path;
  let runCreated = false;
  try {
    if (!req.file) throw new MissingUploadedFileError();
    const outletId = require_(req.body, 'outlet_id');
    await requireSupermarketOutlet({ db: scopedDb().for(req.context), context: req.context, outletId });
    productImport.readProductFile(filePath);
    const run = await migrationService.createImportRun({
      context: req.context,
      entityType: productImport.ENTITY_TYPE,
      propertyId: req.context.propertyId,
      outletId,
      originalFilename: req.file.originalname,
      filePath,
      viaSupermarket: true,
    });
    runCreated = true;
    await req.audit({ entityType: 'import_runs', entityId: run.id, action: 'create', afterState: run });
    const result = await migrationService.runDryRun({ context: req.context, importRunId: run.id, viaSupermarket: true });
    res.status(201).json(ok(await present(req, result, { summary: result.summary })));
  } catch (error) {
    // A refused upload leaves no file behind (no run points at it).
    if (filePath && !runCreated) fs.rm(filePath, { force: true }, () => {});
    next(error);
  }
}

async function getImport(req, res, next) {
  try {
    const found = await loadRun(req);
    if (!found) return notFound(res);
    res.json(ok(await present(req, found)));
  } catch (error) {
    next(error);
  }
}

async function dryRun(req, res, next) {
  try {
    const found = await loadRun(req);
    if (!found) return notFound(res);
    const result = await migrationService.runDryRun({ context: req.context, importRunId: req.params.id, viaSupermarket: true });
    res.json(ok(await present(req, result, { summary: result.summary })));
  } catch (error) {
    next(error);
  }
}

async function commit(req, res, next) {
  try {
    const found = await loadRun(req);
    if (!found) return notFound(res);
    const run = await migrationService.commitImportRun({ context: req.context, importRunId: req.params.id, viaSupermarket: true });
    await req.audit({ entityType: 'import_runs', entityId: run.id, action: 'commit', afterState: run });
    res.status(202).json(ok(run));
  } catch (error) {
    next(error);
  }
}

async function rollback(req, res, next) {
  try {
    const reason = String(require_(req.body, 'reason')).trim();
    if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required.', [{ field: 'reason', issue: 'missing' }]);
    const found = await loadRun(req);
    if (!found) return notFound(res);
    const result = await migrationService.rollbackImportRun({ context: req.context, importRunId: req.params.id, userId: req.context.userId, viaSupermarket: true });
    if (!result) return notFound(res);
    await req.audit({ entityType: 'import_runs', entityId: req.params.id, action: 'rollback', reason, afterState: result });
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

module.exports = { downloadTemplate, listImports, uploadImport, getImport, dryRun, commit, rollback };
