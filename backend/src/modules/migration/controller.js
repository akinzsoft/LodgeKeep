'use strict';

/**
 * HTTP layer for data migration — parses the request, calls `service.js`,
 * shapes the API.md §2 envelope. No business logic here.
 *
 * Deliberately does NOT route through `runIdempotentMutation`
 * (`src/shared/mutation.js`) — unlike AR/Cashiering/Reservations, none of
 * these actions is "the same financial mutation, retried" in the sense
 * that wrapper exists for: uploading the same file twice is meant to
 * create a SECOND run (§3.20's own "each import run gets an id," never a
 * silent replay of the first), a dry run is safely re-runnable by
 * construction, and commit/rollback are each already a real, single
 * conditional-UPDATE-guarded transition with nothing to replay. Every
 * mutation is still audited directly via `req.audit(...)`, the same
 * pattern `offboarding/controller.js` already uses for the identical
 * reason.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { templateCsv } = require('./templates');
const { UnknownEntityTypeError, MissingUploadedFileError } = require('./errors');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

async function downloadTemplate(req, res, next) {
  try {
    const csv = templateCsv(req.params.entityType);
    if (csv === null) throw new UnknownEntityTypeError(req.params.entityType);
    res
      .status(200)
      .set('Content-Type', 'text/csv')
      .set('Content-Disposition', `attachment; filename="${req.params.entityType}-import-template.csv"`)
      .send(csv);
  } catch (error) {
    next(error);
  }
}

async function uploadImport(req, res, next) {
  try {
    if (!req.file) throw new MissingUploadedFileError();
    const run = await service.createImportRun({
      context: req.context,
      entityType: req.body?.entity_type,
      propertyId: req.body?.property_id,
      originalFilename: req.file.originalname,
      filePath: req.file.path,
    });
    await req.audit({ entityType: 'import_runs', entityId: run.id, action: 'create', afterState: run });
    res.status(201).json(ok(run));
  } catch (error) {
    next(error);
  }
}

async function dryRun(req, res, next) {
  try {
    const result = await service.runDryRun({ context: req.context, importRunId: req.params.id });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function getRun(req, res, next) {
  try {
    const result = await service.getImportRun({ context: req.context, importRunId: req.params.id });
    if (!result) return notFound(res);
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function listRuns(req, res, next) {
  try {
    const runs = await service.listImportRuns({ context: req.context, entityType: req.query?.entity_type, status: req.query?.status });
    res.status(200).json(ok(runs));
  } catch (error) {
    next(error);
  }
}

async function resolveDuplicate(req, res, next) {
  try {
    const resolution = require_(req.body, 'resolution');
    const result = await service.resolveDuplicateRow({
      context: req.context,
      importRunId: req.params.id,
      rowNumber: Number(req.params.rowNumber),
      resolution,
      matchedGuestId: req.body?.matched_guest_id,
    });
    if (!result) return notFound(res);
    await req.audit({ entityType: 'import_row_errors', entityId: result.id, action: 'resolve_duplicate', afterState: result });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function commit(req, res, next) {
  try {
    const run = await service.commitImportRun({ context: req.context, importRunId: req.params.id });
    await req.audit({ entityType: 'import_runs', entityId: run.id, action: 'commit', afterState: run });
    res.status(202).json(ok(run));
  } catch (error) {
    next(error);
  }
}

async function rollback(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    const result = await service.rollbackImportRun({ context: req.context, importRunId: req.params.id, userId: req.context.userId });
    if (!result) return notFound(res);
    await req.audit({ entityType: 'import_runs', entityId: req.params.id, action: 'rollback', reason, afterState: result });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

module.exports = { downloadTemplate, uploadImport, dryRun, getRun, listRuns, resolveDuplicate, commit, rollback };
