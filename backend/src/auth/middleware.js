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
const { contextFromSession, guestContextFromSession, platformContext, impersonationContext, systemContext } = require('../modules/tenancy');
const {
  UnauthenticatedError,
  TokenExpiredError,
  TokenInvalidError,
  WrongAudienceError,
  SessionInvalidError,
  ImpersonationEndedError,
} = require('./errors');

/**
 * PLAN.md Phase 5 (Platform Foundation) — API.md §4's "checked per request,
 * not just at token issuance" for an impersonation grant, satisfied
 * literally: the token carries only `sub` (a `platform_users.id`) and
 * `impersonation_session_id`, never a tenant/property claim, so EVERY
 * request re-reads the live `impersonation_sessions` row and re-derives
 * both from it. See `context.js`'s `impersonationContext` for why this
 * builds a STAFF-audience context rather than a new one.
 */
async function liveImpersonationContext(claims) {
  const db = scopedDb();
  const row = await db
    .for(systemContext())
    .platform()
    .table('impersonation_sessions')
    .where({ id: claims.impersonation_session_id })
    .first();

  if (!row || String(row.platform_user_id) !== String(claims.sub) || row.ended_at || new Date(row.expires_at) <= new Date()) {
    throw new ImpersonationEndedError();
  }

  const platformUser = await db.for(systemContext()).platform().table('platform_users')
    .where({ id: row.platform_user_id }).first();
  if (!platformUser || platformUser.status !== 'active') throw new SessionInvalidError();

  return impersonationContext({
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    impersonationSessionId: row.id,
    platformUserId: row.platform_user_id,
  });
}

async function liveContextFor(claims) {
  const db = scopedDb();

  if (claims.aud === 'staff_impersonation') {
    return liveImpersonationContext(claims);
  }

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
    // Gap closure (feature-dev): guest password-reset's session-invalidation
    // mechanism. No `sessions`-equivalent table exists for guests to revoke
    // rows in (short-lived, no-refresh access tokens) — a token issued
    // before the account's last password change is rejected instead,
    // the stateless-JWT equivalent of a row-based revoke. See the migration
    // that added `password_changed_at` for the full reasoning.
    //
    // `Math.ceil`, not a direct millisecond comparison: `iat` (JWT spec) is
    // only second-granular — `claims.iat` is the FLOOR of the real issue
    // instant, discarding its position within that second. Comparing that
    // floor directly against a millisecond-precise `password_changed_at`
    // is asymmetric: it correctly rejects a token from an earlier second,
    // but a token issued in the SAME second as the reset can land on
    // either side of the millisecond boundary depending on where within
    // that second each event fell — an unpredictable false accept OR
    // false reject. Rounding the boundary UP to the start of the next
    // whole second removes the ambiguity in the safe direction: every
    // token from the reset's own second or earlier is rejected (a
    // password reset invalidating a token minted a few hundred
    // milliseconds earlier, in the worst case, is exactly the conservative
    // behaviour AUTH-8's "every existing session" already models for
    // staff), and every token from a genuinely later second is accepted
    // normally.
    if (guest.password_changed_at) {
      const invalidateBefore = Math.ceil(new Date(guest.password_changed_at).getTime() / 1000);
      if (claims.iat < invalidateBefore) throw new SessionInvalidError();
    }
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

      // PLAN.md Phase 5: a `staff_impersonation` token satisfies exactly the
      // staff tree's own audience check, and nothing else — it can never
      // satisfy `authenticate('guest')`/`authenticate('platform')`. See
      // `tokens.js`'s own header for why this is a distinct wire audience,
      // never literally `aud: 'staff'`.
      const audienceOk = claims.aud === audience || (audience === 'staff' && claims.aud === 'staff_impersonation');
      if (!audienceOk) throw new WrongAudienceError();

      req.claims = claims;
      req.context = await liveContextFor(claims);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { authenticate };
