'use strict';

/**
 * Resolves the raw token in `req.params.token` into a real, active
 * `pos_order_tokens` row and builds this request's anonymous guest
 * context — every guest-facing route in this module runs on this, the
 * exact "public, pre-auth bootstrap lookup" shape
 * `src/modules/portal/middleware.js`'s own `resolvePortalProperty`
 * already established for the identical structural problem (a property
 * isn't known yet either, there).
 *
 * The tenant IS already known at this point, from the Host header
 * (`resolveTenant`, mounted ahead of this middleware exactly like
 * `portalPublicRouter`'s own per-route mount) — a QR code encodes the
 * scanning property's own subdomain in its URL, so the request already
 * carries tenant identity the same way every other public portal route
 * does. `pos_order_tokens` is PROPERTY_SCOPED, but the property is what
 * THIS lookup resolves — `.acrossProperties()` (tenant-scoped, spanning
 * every property) is the one legitimate way to search for it, the same
 * "search before the narrower scope is known" reasoning
 * `resolvePropertyBySlug` already documents for tenant-scoped bootstrap
 * lookups.
 *
 * A missing, unknown, inactive, or wrong-tenant token 404s — the same
 * "an unresolved lookup reveals nothing" convention `resolveTenant`/
 * `resolvePortalProperty` already establish, rather than a 400/422 that
 * would confirm a token could ever have existed with that shape. This is
 * also this module's own real defense against a tampered/forged token:
 * a token whose hash matches nothing active gets the identical response a
 * merely-mistyped one does.
 */

const { scopedDb } = require('../../db');
const { contextFromSession, guestContextFromSession } = require('../tenancy');
const { notFound } = require('../../shared/response');
const { hashToken } = require('./tokens');

function resolveQrOrderToken() {
  return async function resolveQrOrderTokenMiddleware(req, res, next) {
    try {
      const rawToken = req.params.token;
      if (!rawToken) return notFound(res);

      const tenantOnlyContext = contextFromSession({ tenantId: req.tenantId });
      const tokenRow = await scopedDb()
        .for(tenantOnlyContext)
        .acrossProperties()
        .table('pos_order_tokens')
        .where({ token_hash: hashToken(rawToken), active: true })
        .first();
      if (!tokenRow) return notFound(res);

      req.qrToken = tokenRow;
      req.context = guestContextFromSession({ tenantId: req.tenantId, propertyId: tokenRow.property_id, guestAccountId: null });
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { resolveQrOrderToken };
