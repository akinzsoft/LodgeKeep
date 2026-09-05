'use strict';

/**
 * HTTP layer for Profiles (Guest CRM) — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const service = require('./service');
const { ValidationError } = require('../../shared/errors');

function requireQuery(query, field) {
  const value = query?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value.trim();
}

async function searchGuests(req, res, next) {
  try {
    const query = requireQuery(req.query, 'q');
    res.status(200).json(ok(await service.searchGuests({ context: req.context, query })));
  } catch (error) {
    next(error);
  }
}

async function getGuest(req, res, next) {
  try {
    const guest = await service.getGuest({ context: req.context, id: req.params.id });
    if (!guest) return notFound(res);
    res.status(200).json(ok(guest));
  } catch (error) {
    next(error);
  }
}

async function getGuestStayHistory(req, res, next) {
  try {
    const guest = await service.getGuest({ context: req.context, id: req.params.id });
    if (!guest) return notFound(res);
    res.status(200).json(ok(await service.getGuestStayHistory({ context: req.context, id: req.params.id })));
  } catch (error) {
    next(error);
  }
}

module.exports = { searchGuests, getGuest, getGuestStayHistory };
