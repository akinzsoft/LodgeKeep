'use strict';

/**
 * MFA challenge issuance and verification — PRODUCT_REQUIREMENTS.md §3.16
 * ("MFA mandatory for admin/super_admin, no opt-out"). Real TOTP secret
 * generation, enrollment, and verification are NOT built here — see
 * `errors.js`'s `MfaNotImplementedError` header for that gap. This file's
 * only real job is minting and checking the short-lived challenge token
 * `staffLogin` issues instead of full access tokens whenever
 * `roleRequiresMfa`/`user.mfa_enabled` triggers a challenge (`service.js`'s
 * `mfa_challenge_required` branch), plus a single, explicitly dev-only
 * bypass code that lets a real MFA-required account (admin/super_admin)
 * actually finish logging in outside production. Before this file existed,
 * no admin/super_admin account could complete login at all — not even in
 * development — which is a real gap for anyone needing to exercise an
 * admin-only screen (Setup's `setup.manage`, for one) through a browser
 * rather than the test suite's direct-token-minting harness.
 *
 * `isDevBypassCode` is gated on `process.env.NODE_ENV !== 'production'`
 * ONLY — a literal string comparison, never a separate feature flag that
 * could be left on by accident — the same pattern `service.js`'s
 * `requestPasswordReset` already uses to expose its own dev-only reset
 * token outside production. In production this always returns `false`, so
 * the mfa-verify endpoint falls straight through to the exact
 * `501 AUTH_MFA_NOT_IMPLEMENTED` it has always returned — this file changes
 * no production behaviour at all.
 *
 * Platform login (`platformLogin`) never calls `signMfaChallengeToken` — it
 * has no token-issuance path to resume into once "verified" at all yet (see
 * that function's own header), so this bypass only ever completes a STAFF
 * login. A platform MFA-verify attempt still falls through to
 * `MfaNotImplementedError`, unchanged.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const CHALLENGE_TTL = '5m';
const CHALLENGE_AUD = 'staff_mfa_challenge';

// Fixed and documented, never read from an environment variable — a
// misconfigured or leaked env var could otherwise enable this in a
// deployment that only forgot to set NODE_ENV=production. The NODE_ENV
// check in `isDevBypassCode` is the only gate.
const DEV_MFA_BYPASS_CODE = '000000';

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error('JWT_SECRET is not set. See .env.example — never fall back to a default in code.');
  }
  return value;
}

/**
 * Issued instead of full tokens whenever a login resolves to
 * `mfa_challenge_required`. Carries just enough to resume that specific
 * login — no role or permission claim (the same "no role claim" rule
 * `tokens.js`'s header states for access tokens applies here too) — and a
 * distinct `aud` so it can never be mistaken for, or accepted as, a real
 * access token even if `verifyAccessToken` were pointed at it by mistake.
 */
function signMfaChallengeToken({ userId, tenantId }) {
  return jwt.sign({ aud: CHALLENGE_AUD, sub: String(userId), tenant_id: String(tenantId) }, secret(), {
    expiresIn: CHALLENGE_TTL,
    jwtid: crypto.randomUUID(),
  });
}

/** Throws on an invalid, expired, or wrong-audience token — never returns a partial or best-effort result. */
function verifyMfaChallengeToken(token) {
  const payload = jwt.verify(token, secret());
  if (payload.aud !== CHALLENGE_AUD) {
    throw new jwt.JsonWebTokenError('Not a staff MFA challenge token.');
  }
  return payload;
}

/**
 * True only outside production and only for the exact dev bypass code —
 * the entire "MFA verification" this codebase performs today. See this
 * file's own header for why a real TOTP check isn't built here yet.
 */
function isDevBypassCode(code) {
  return process.env.NODE_ENV !== 'production' && code === DEV_MFA_BYPASS_CODE;
}

module.exports = { signMfaChallengeToken, verifyMfaChallengeToken, isDevBypassCode, DEV_MFA_BYPASS_CODE };
