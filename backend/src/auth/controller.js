'use strict';

/**
 * HTTP layer for `src/auth` — parses the request, calls the service, shapes
 * the API.md §2 envelope. No business logic here; see `service.js`.
 */

const { ok } = require('../shared/response');
const service = require('./service');
const { ValidationError, MfaNotImplementedError } = require('./errors');

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
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/auth/refresh */
async function staffRefresh(req, res, next) {
  try {
    const refreshToken = require_(req.body, 'refresh_token');
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
    res.status(200).json(
      ok({ accessToken: result.accessToken, refreshToken: result.refreshToken })
    );
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/auth/logout */
async function staffLogout(req, res, next) {
  try {
    const refreshToken = require_(req.body, 'refresh_token');
    const result = await service.staffLogout({ context: req.context, refreshToken, ...requestMeta(req) });
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

/** POST /api/v1/portal/auth/login */
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

/**
 * POST /auth/mfa/verify — staff and platform both. Fixed shape, not yet
 * implemented; see `MfaNotImplementedError`.
 */
async function verifyMfa(req, res, next) {
  try {
    require_(req.body, 'challenge_token');
    require_(req.body, 'code');
    throw new MfaNotImplementedError();
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

module.exports = {
  staffLogin,
  staffRefresh,
  staffLogout,
  switchProperty,
  requestPasswordReset,
  completePasswordReset,
  guestLogin,
  platformLogin,
  verifyMfa,
};
