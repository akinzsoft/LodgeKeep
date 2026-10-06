'use strict';

const { ok } = require('../../shared/response');
const service = require('./service');

async function getPublic(req, res, next) {
  try {
    const content = await service.getPublicContent();
    // Public, identical for every visitor and containing no tenant data, so a
    // short shared cache is safe: an edit in the console is live within a minute.
    // Set only after success so an error response is never cached.
    res.set('Cache-Control', 'public, max-age=60');
    res.status(200).json(ok(content));
  } catch (error) {
    next(error);
  }
}

async function getConsole(req, res, next) {
  try {
    res.status(200).json(ok(await service.getConsoleView({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function save(req, res, next) {
  try {
    res.status(200).json(ok(await service.saveContent({ context: req.context, content: req.body?.content })));
  } catch (error) {
    next(error);
  }
}

async function reset(req, res, next) {
  try {
    res.status(200).json(ok(await service.resetToDefaults({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function restore(req, res, next) {
  try {
    res.status(200).json(ok(await service.restoreVersion({ context: req.context, versionId: req.params.id })));
  } catch (error) {
    next(error);
  }
}

module.exports = { getPublic, getConsole, save, reset, restore };
