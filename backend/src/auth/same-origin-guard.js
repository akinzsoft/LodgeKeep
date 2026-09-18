'use strict';

const { fail } = require('../shared/response');

/**
 * CSRF defense-in-depth for the two routes authenticated by the refresh
 * cookie alone (`refresh-cookie.js`) — `POST /auth/refresh` and
 * `POST /auth/logout`. `SameSite=Lax` is already the real, primary
 * defense (a cross-site POST never attaches the cookie at all in any
 * SameSite-Lax-respecting browser) — security-review finding: add an
 * explicit `Origin`/`Referer` check too, so this doesn't rest on
 * `SameSite` alone if a browser's own handling of it is ever weaker than
 * expected, or the cookie's own attributes are loosened later without
 * anyone noticing.
 *
 * Compares the request's own declared origin against `req.headers.host`
 * (the Host this exact request arrived on) — never a hardcoded app
 * domain, since the same backend serves every tenant subdomain and the
 * dev-vs-production origin shape differs (`main.jsx`'s Vite proxy forwards
 * the browser's real Host unchanged — `changeOrigin: false`, this repo's
 * own documented fix — so Host and Origin already agree in both
 * environments for a genuine same-origin request).
 *
 * A request with NEITHER `Origin` nor `Referer` is allowed through rather
 * than rejected — some legitimate same-origin requests (older browsers,
 * certain redirect chains) omit both, and `SameSite=Lax` already covers
 * the real cross-site-POST case; this guard exists to catch a MISMATCHED
 * origin, not to demand one be present.
 */
function requestOrigin(req) {
  const originHeader = req.headers.origin;
  if (originHeader) return originHeader;
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined; // malformed Referer — treated as a real mismatch below, not "absent"
  }
}

function isSameOrigin(req) {
  const origin = requestOrigin(req);
  if (origin === null) return true;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function requireSameOrigin(req, res, next) {
  if (!isSameOrigin(req)) {
    res.status(403).json(fail('FORBIDDEN_CROSS_ORIGIN', 'This request did not originate from the expected origin.', { requestId: req.requestId }));
    return;
  }
  next();
}

module.exports = { requireSameOrigin, isSameOrigin };
