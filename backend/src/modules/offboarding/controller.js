'use strict';

const { ok, notFound } = require('../../shared/response');
const service = require('./service');

function requestMeta(req) {
  return { ip: req.ip, userAgent: req.get('User-Agent'), requestId: req.requestId };
}

async function requestOffboarding(req, res, next) {
  try {
    const result = await service.requestOwnOffboarding({ context: req.context, reason: req.body?.reason, ...requestMeta(req) });
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function getStatus(req, res, next) {
  try {
    res.status(200).json(ok(await service.getOffboardingStatus({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function retryExport(req, res, next) {
  try {
    const result = await service.retryFailedExport({ context: req.context, exportId: req.params.exportId });
    if (!result) return notFound(res);
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function downloadExport(req, res, next) {
  try {
    const download = await service.downloadExport({ context: req.context, exportId: req.params.exportId });
    if (!download) return notFound(res);
    res.download(download.filePath, download.fileName);
  } catch (error) {
    next(error);
  }
}

module.exports = { requestOffboarding, getStatus, retryExport, downloadExport };
