'use strict';

/**
 * Resolves `property_slug` (query for GET, body for POST) into a real
 * property under this request's already-resolved tenant (`req.tenantId`,
 * set by `resolveTenant`), and sets `req.context` to an ANONYMOUS guest
 * context (`guestAccountId: null`) — every public, pre-login portal route
 * runs on this. `authenticate('guest')` (src/auth/middleware.js) is what
 * replaces `req.context` with a real, account-bound one once a bearer
 * token is presented instead, on the authenticated tier.
 *
 * 404s on an unknown or missing slug, matching `resolveTenant`'s own "an
 * unresolved lookup reveals nothing" convention, rather than a 400/422
 * that would confirm no property could ever have had that name.
 */

const { scopedDb } = require('../../db');
const { guestContextFromSession, resolvePropertyBySlug } = require('../tenancy');
const { notFound } = require('../../shared/response');

function resolvePortalProperty() {
  return async function resolvePortalPropertyMiddleware(req, res, next) {
    try {
      const propertySlug = req.method === 'GET' ? req.query.property_slug : req.body?.property_slug;
      if (!propertySlug) return notFound(res);

      const property = await resolvePropertyBySlug({ db: scopedDb(), tenantId: req.tenantId, propertySlug });
      if (!property) return notFound(res);

      req.context = guestContextFromSession({ tenantId: req.tenantId, propertyId: property.id, guestAccountId: null });
      req.portalProperty = property;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { resolvePortalProperty };
