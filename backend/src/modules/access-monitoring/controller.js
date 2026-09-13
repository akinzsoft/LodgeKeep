'use strict';

/**
 * Door access monitoring HTTP layer — thin, mirroring migration/controller.js.
 * Every mutation is audited via `req.audit`; the import commit's audit row
 * carries the full summary, which doubles as the property's import history.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { MissingLockFileError } = require('./errors');
const service = require('./service');

function uploadedBuffer(req) {
  if (!req.file || !req.file.buffer) throw new MissingLockFileError();
  return req.file.buffer;
}

/** The mapping travels as a JSON string field alongside the multipart file. */
function parseMapping(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('DOOR_ACCESS_MAPPING_INVALID', '"mapping" must be a JSON object.', [{ field: 'mapping', issue: 'invalid_json' }]);
  }
}

async function getConfig(req, res, next) {
  try {
    res.status(200).json(ok(await service.getConfig({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function updateConfig(req, res, next) {
  try {
    const { before, after } = await service.updateConfig({
      context: req.context,
      adapter: req.body?.adapter,
      postCheckoutGraceMinutes: req.body?.post_checkout_grace_minutes,
    });
    await req.audit({ entityType: 'lock_system_config', entityId: after.id, action: before ? 'update' : 'create', beforeState: before, afterState: after });
    res.status(200).json(ok(after));
  } catch (error) {
    next(error);
  }
}

async function readHeaders(req, res, next) {
  try {
    res.status(200).json(ok(await service.readHeaders({ context: req.context, buffer: uploadedBuffer(req) })));
  } catch (error) {
    next(error);
  }
}

async function previewImport(req, res, next) {
  try {
    const buffer = uploadedBuffer(req);
    res.status(200).json(ok(await service.previewImport({ context: req.context, buffer, mapping: parseMapping(req.body?.mapping) })));
  } catch (error) {
    next(error);
  }
}

async function commitImport(req, res, next) {
  try {
    const buffer = uploadedBuffer(req);
    const summary = await service.commitImport({ context: req.context, buffer, mapping: parseMapping(req.body?.mapping) });
    await req.audit({
      entityType: 'lock_system_config',
      entityId: summary.configId,
      action: 'import_lock_audit_trail',
      afterState: { ...summary, originalFilename: req.file.originalname },
    });
    service.dispatchNotificationsSoon(req.context, summary);
    res.status(201).json(ok(summary));
  } catch (error) {
    next(error);
  }
}

async function listAlerts(req, res, next) {
  try {
    const q = req.query ?? {};
    const alerts = await service.listAlerts({
      context: req.context,
      filters: { status: q.status, severity: q.severity, rule: q.rule, roomId: q.room_id, from: q.from, to: q.to },
    });
    res.status(200).json(ok(alerts));
  } catch (error) {
    next(error);
  }
}

async function getAlert(req, res, next) {
  try {
    const alert = await service.getAlert({ context: req.context, id: req.params.id });
    if (!alert) return notFound(res);
    res.status(200).json(ok(alert));
  } catch (error) {
    next(error);
  }
}

function transition(to) {
  return async function transitionHandler(req, res, next) {
    try {
      const result = await service.transitionAlert({
        context: req.context,
        id: req.params.id,
        to,
        userId: req.context.userId,
        reason: req.body?.reason,
      });
      if (!result) return notFound(res);
      await req.audit({
        entityType: 'access_alerts',
        entityId: req.params.id,
        action: to === 'acknowledged' ? 'acknowledge' : 'resolve',
        beforeState: result.before,
        afterState: result.after,
        reason: to === 'resolved' ? result.after.resolution_reason : undefined,
      });
      res.status(200).json(ok(result.after));
    } catch (error) {
      next(error);
    }
  };
}

async function listStayConfirmations(req, res, next) {
  try {
    res.status(200).json(ok(await service.listStayConfirmations({ context: req.context, from: req.query?.from, to: req.query?.to })));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getConfig,
  updateConfig,
  readHeaders,
  previewImport,
  commitImport,
  listAlerts,
  getAlert,
  acknowledgeAlert: transition('acknowledged'),
  resolveAlert: transition('resolved'),
  listStayConfirmations,
};
