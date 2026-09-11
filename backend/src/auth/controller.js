'use strict';

/**
 * HTTP layer for `src/auth` — parses the request, calls the service, shapes
 * the API.md §2 envelope. No business logic here; see `service.js`.
 */

const { ok } = require('../shared/response');
const service = require('./service');
const { ValidationError, TokenInvalidError } = require('./errors');
const { REFRESH_TTL_HOURS } = require('./tokens');
const {
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  readRefreshTokenCookie,
  refreshTokenMaxAgeMs,
} = require('./refresh-cookie');

const REFRESH_TOKEN_MAX_AGE_MS = refreshTokenMaxAgeMs(REFRESH_TTL_HOURS);

/**
 * Gap closure: the refresh token used to travel in the JSON response body,
 * which is why `AuthContext.jsx` had to hold it in a JS variable and lost it
 * on every page reload. It now travels ONLY as an HttpOnly cookie
 * (`refresh-cookie.js`) — stripped from every response body below so it
 * never touches JS at all, not even transiently.
 */
function stripRefreshToken(result) {
  const { refreshToken, ...rest } = result;
  return rest;
}

/**
 * Gap closure: `mfa_challenge_required` now carries a real `devOnlyCode`
 * (outside production only — `service.js`'s own `staffLogin` header) —
 * renamed to snake_case here to match the `dev_only_token` shape every
 * other credential-issuing endpoint in this file already uses
 * (`requestPasswordReset` below, `guestRegister`/`inviteUser` elsewhere).
 */
function renameDevOnlyCode(result) {
  if (!('devOnlyCode' in result)) return result;
  const { devOnlyCode, ...rest } = result;
  return { ...rest, dev_only_code: devOnlyCode };
}

function require_(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

function requestMeta(req) {
  return { ip: req.ip, userAgent: req.get('User-Agent'), requestId: req.requestId };
}

/** POST /api/v1/auth/login */
async function staffLogin(req, res, next) {
  try {
    const email = require_(req.body, 'email');
    const password = require_(req.body, 'password');
    const result = await service.staffLogin({
      tenantId: req.tenantId,
      email,
      password,
      ...requestMeta(req),
    });
    // `mfa_challenge_required` carries no refreshToken yet — nothing to set.
    if (result.refreshToken) {
      setRefreshTokenCookie(res, result.refreshToken, { maxAgeMs: REFRESH_TOKEN_MAX_AGE_MS });
    }
    res.status(200).json(ok(renameDevOnlyCode(stripRefreshToken(result))));
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/auth/refresh — the refresh token now comes from the
 * HttpOnly cookie, never the request body (see `refresh-cookie.js`'s
 * header). A missing cookie is the same `TokenInvalidError` the service
 * layer already throws for an unknown/expired/revoked one — there is
 * nothing to distinguish it from the caller's point of view.
 */
async function staffRefresh(req, res, next) {
  try {
    const refreshToken = readRefreshTokenCookie(req);
    if (!refreshToken) throw new TokenInvalidError();
    // Optional: the client's own record of its active property, restored
    // (after re-verification) rather than silently dropped on every rotation
    // — see the note in service.js's staffRefresh.
    const propertyId = typeof req.body?.property_id === 'string' ? req.body.property_id : undefined;
    const result = await service.staffRefresh({
      tenantId: req.tenantId,
      refreshToken,
      propertyId,
      ...requestMeta(req),
    });
    setRefreshTokenCookie(res, result.refreshToken, { maxAgeMs: REFRESH_TOKEN_MAX_AGE_MS });
    res.status(200).json(ok(stripRefreshToken(result)));
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/auth/logout — reads the same cookie, revokes the session it
 * names (if any), and clears the cookie either way. No cookie at all is
 * treated as an already-logged-out no-op (200, `revoked: false`) rather than
 * a validation error — the caller's goal ("stop being logged in") is already
 * true.
 *
 * Gap closure: no longer requires a valid access token at all — `tenantId`
 * comes from `resolveTenant` (the Host header), same as `/login`/`/refresh`,
 * not from `req.context`. See `service.js`'s own `staffLogout` header for
 * the real, live-reproduced bug this closes.
 */
async function staffLogout(req, res, next) {
  try {
    const refreshToken = readRefreshTokenCookie(req);
    const result = refreshToken
      ? await service.staffLogout({ tenantId: req.tenantId, refreshToken, ...requestMeta(req) })
      : { revoked: false };
    clearRefreshTokenCookie(res);
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/auth/switch-property — API.md §5's documented shape. */
async function switchProperty(req, res, next) {
  try {
    const propertyId = require_(req.body, 'property_id');
    const result = await service.switchProperty({ context: req.context, propertyId });
    res
      .status(200)
      .json(ok({ accessToken: result.accessToken, activePropertyId: result.activePropertyId, role: result.role }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/auth/password/forgot */
async function requestPasswordReset(req, res, next) {
  try {
    const email = require_(req.body, 'email');
    const result = await service.requestPasswordReset({
      tenantId: req.tenantId,
      email,
      ...requestMeta(req),
    });
    // AUTH-7/PRODUCT_REQUIREMENTS.md §3.16: same response whether or not the
    // address resolved. devOnlyToken is undefined/null outside dev-mode
    // handling in the service, and is omitted from the response entirely once
    // a real email sender exists.
    res.status(200).json(ok({ status: 'ok', dev_only_token: result.devOnlyToken }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/auth/password/reset */
async function completePasswordReset(req, res, next) {
  try {
    const token = require_(req.body, 'token');
    const newPassword = require_(req.body, 'new_password');
    const result = await service.completePasswordReset({
      tenantId: req.tenantId,
      token,
      newPassword,
      ...requestMeta(req),
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/auth/invitations/accept */
async function acceptInvitation(req, res, next) {
  try {
    const token = require_(req.body, 'token');
    const firstName = require_(req.body, 'first_name');
    const lastName = require_(req.body, 'last_name');
    const password = require_(req.body, 'password');
    const result = await service.acceptInvitation({
      tenantId: req.tenantId,
      token,
      firstName,
      lastName,
      password,
      ...requestMeta(req),
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/portal/auth/login */
/** POST /api/v1/portal/auth/register */
async function guestRegister(req, res, next) {
  try {
    const propertySlug = require_(req.body, 'property_slug');
    const email = require_(req.body, 'email');
    const password = require_(req.body, 'password');
    const firstName = require_(req.body, 'first_name');
    const lastName = require_(req.body, 'last_name');
    const result = await service.guestRegister({
      tenantId: req.tenantId,
      propertySlug,
      email,
      password,
      firstName,
      lastName,
      phone: req.body?.phone,
      ...requestMeta(req),
    });
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function guestLogin(req, res, next) {
  try {
    const propertySlug = require_(req.body, 'property_slug');
    const email = require_(req.body, 'email');
    const password = require_(req.body, 'password');
    const result = await service.guestLogin({
      tenantId: req.tenantId,
      propertySlug,
      email,
      password,
      ...requestMeta(req),
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/portal/auth/password/forgot */
async function requestGuestPasswordReset(req, res, next) {
  try {
    const propertySlug = require_(req.body, 'property_slug');
    const email = require_(req.body, 'email');
    const result = await service.requestGuestPasswordReset({
      tenantId: req.tenantId,
      propertySlug,
      email,
      ...requestMeta(req),
    });
    // Same anti-enumeration shape as staff's own /password/forgot above —
    // identical response whether or not the address resolved.
    res.status(200).json(ok({ status: 'ok', dev_only_token: result.devOnlyToken }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/portal/auth/password/reset */
async function completeGuestPasswordReset(req, res, next) {
  try {
    const token = require_(req.body, 'token');
    const newPassword = require_(req.body, 'new_password');
    const result = await service.completeGuestPasswordReset({
      tenantId: req.tenantId,
      token,
      newPassword,
      ...requestMeta(req),
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/mfa/verify — staff and platform both. The only real
 * verification performed is `src/auth/mfa.js`'s dev-only bypass code,
 * checked strictly outside production — see that file's own header. A
 * platform challenge token is never issued (`platformLogin` has no
 * token-issuance path to resume into yet), so a platform caller always
 * falls through to `MfaNotImplementedError`, this endpoint's original and
 * still-default behaviour for everyone else.
 */
async function verifyMfa(req, res, next) {
  try {
    const challengeToken = require_(req.body, 'challenge_token');
    const code = require_(req.body, 'code');
    const result = await service.verifyStaffMfa({ challengeToken, code, ...requestMeta(req) });
    if (result.refreshToken) {
      setRefreshTokenCookie(res, result.refreshToken, { maxAgeMs: REFRESH_TOKEN_MAX_AGE_MS });
    }
    res.status(200).json(ok(stripRefreshToken(result)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/platform/auth/login */
async function platformLogin(req, res, next) {
  try {
    const email = require_(req.body, 'email');
    const password = require_(req.body, 'password');
    const result = await service.platformLogin({ email, password, ...requestMeta(req) });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/platform/auth/mfa/enroll/confirm — the first-login TOTP enrollment round trip. */
async function platformMfaEnrollConfirm(req, res, next) {
  try {
    const enrollmentToken = require_(req.body, 'enrollment_token');
    const code = require_(req.body, 'code');
    const result = await service.confirmPlatformMfaEnrollment({ enrollmentToken, code, ...requestMeta(req) });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/platform/auth/mfa/verify — real TOTP verification, distinct from staff's own `verifyMfa`. */
async function verifyPlatformMfa(req, res, next) {
  try {
    const challengeToken = require_(req.body, 'challenge_token');
    const code = require_(req.body, 'code');
    const result = await service.verifyPlatformMfa({ challengeToken, code, ...requestMeta(req) });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  staffLogin,
  staffRefresh,
  staffLogout,
  switchProperty,
  requestPasswordReset,
  completePasswordReset,
  acceptInvitation,
  guestRegister,
  guestLogin,
  requestGuestPasswordReset,
  completeGuestPasswordReset,
  platformLogin,
  platformMfaEnrollConfirm,
  verifyPlatformMfa,
  verifyMfa,
};
