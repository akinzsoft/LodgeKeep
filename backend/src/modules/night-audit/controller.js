'use strict';

/**
 * HTTP layer for the night-audit module — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 *
 * `runNightAudit` does NOT go through the generic idempotent-mutation
 * wrapper — see `service.js`'s own header for why its run-row claim is a
 * stronger, purpose-built mechanism instead.
 */

const { ok, notFound } = require('../../shared/response');
const service = require('./service');

async function runNightAudit(req, res, next) {
  try {
    const result = await service.runNightAudit({ context: req.context, userId: req.context.userId });
    await req.audit({
      entityType: 'night_audit_runs',
      entityId: result.run.id,
      action: 'run',
      afterState: result.run,
    });
    res.status(200).json(ok(result.dailyReport, { run: result.run, exceptions: result.exceptions, nextBusinessDate: result.nextBusinessDate }));
  } catch (error) {
    next(error);
  }
}

async function getRun(req, res, next) {
  try {
    const run = await service.getRun({ context: req.context, id: req.params.id });
    if (!run) return notFound(res);
    res.status(200).json(ok(run));
  } catch (error) {
    next(error);
  }
}

async function listRuns(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRuns({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function getDailyReport(req, res, next) {
  try {
    const report = await service.getDailyReport({ context: req.context, businessDate: req.params.businessDate });
    if (!report) return notFound(res);
    res.status(200).json(ok(report));
  } catch (error) {
    next(error);
  }
}

module.exports = { runNightAudit, getRun, listRuns, getDailyReport };
