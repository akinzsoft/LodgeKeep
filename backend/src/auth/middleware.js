'use strict';

/**
 * `authenticate(audience)` — API.md §4's three route trees, TESTING.md AUTH-5,
 * AUTH-10, AUTH-12, AUTH-15.
 *
 * Verifies the bearer access token, confirms it was minted for the audience
 * this route tree serves, and re-checks the account's live status against the
 * database before attaching `req.context` — a signature check alone proves the
 * token hasn't been forged, not that the account it names is still active
 * (AUTH-10 requires deactivation to take effect on the very next request, which
 * a purely stateless JWT cannot do).
 *
 * Mounted with `router.use()` ahead of every route in a tree except the small
 * public allow-list checked first (`src/app.js`), so a route added later
 * inherits protection automatically — AUTH-15's "never because a decorator was
 * forgotten".
 */

const jwt = require('jsonwebtoken');
const { verifyAccessToken } = require('./tokens');
const { scopedDb } = require('../db');
const { contextFromSession, guestContextFromSession, platformContext } = require('../modules/tenancy');
const {
  UnauthenticatedError,
  TokenExpiredError,
  TokenInvalidError,
  WrongAudienceError,
  SessionInvalidError,
} = require('./errors');

async function liveContextFor(claims) {
  const db = scopedDb();

  if (claims.aud === 'staff') {
    const context = contextFromSession({
      tenantId: claims.tenant_id,
      userId: claims.sub,
      propertyId: claims.property_id,
    });
    const user = await db.for(context).table('users').where({ id: claims.sub }).first();
    if (!user || user.status !== 'active') throw new SessionInvalidError();
    return context;
  }

  if (claims.aud === 'guest') {
    const context = guestContextFromSession({
      tenantId: claims.tenant_id,
      propertyId: claims.property_id,
      guestAccountId: claims.sub,
    });
    const guest = await db.for(context).table('guest_accounts').where({ id: claims.sub }).first();
    if (!guest || guest.status !== 'active') throw new SessionInvalidError();
    return context;
  }

  // platform
  const context = platformContext({ platformUserId: claims.sub });
  const platformUser = await db
    .for(context)
    .platform()
    .table('platform_users')
    .where({ id: claims.sub })
    .first();
  if (!platformUser || platformUser.status !== 'active') throw new SessionInvalidError();
  return context;
}

/** @param {'staff'|'guest'|'platform'} audience */
function authenticate(audience) {
  return async function authenticateMiddleware(req, res, next) {
    try {
      const header = req.get('Authorization') || '';
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) throw new UnauthenticatedError();

      let claims;
      try {
        claims = verifyAccessToken(token);
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) throw new TokenExpiredError();
        throw new TokenInvalidError('This access token is not valid.');
      }

      if (claims.aud !== audience) throw new WrongAudienceError();

      req.claims = claims;
      req.context = await liveContextFor(claims);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { authenticate };
