'use strict';

const { ok } = require('../../shared/response');
const service = require('./service');
const { setRefreshTokenCookie, REFRESH_TOKEN_MAX_AGE_MS } = require('../../auth');

/**
 * Gap closure: `signupTenant` mints a refresh token via the same
 * `issueStaffSession` `staffLogin` uses, but this was the one credential-
 * issuing endpoint still returning it in the JSON body — `src/auth`'s own
 * public surface never had this stripped here the way it is for
 * login/refresh/mfa-verify. Fixed the same way: set as the identical
 * HttpOnly cookie those endpoints use (safe to set from this response even
 * though this route lives outside `/api/v1/auth` — the cookie's own `Path`
 * scopes where the BROWSER later sends it, not where it may be set from),
 * then stripped from the body so it never touches JS at all, not even
 * transiently.
 */
function stripRefreshToken(result) {
  const { refreshToken, ...rest } = result;
  return rest;
}

async function signup(req, res, next) {
  try {
    const body = req.body ?? {};
    const result = await service.signupTenant({
      companyName: body.company_name,
      slug: body.slug,
      timezone: body.timezone,
      baseCurrency: body.base_currency,
      propertyName: body.property_name,
      adminEmail: body.admin_email,
      adminPassword: body.admin_password,
      adminFirstName: body.admin_first_name,
      adminLastName: body.admin_last_name,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      requestId: req.requestId,
    });
    setRefreshTokenCookie(res, result.refreshToken, { maxAgeMs: REFRESH_TOKEN_MAX_AGE_MS });
    res.status(201).json(ok(stripRefreshToken(result)));
  } catch (error) {
    next(error);
  }
}

module.exports = { signup };
