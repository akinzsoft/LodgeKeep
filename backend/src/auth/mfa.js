'use strict';

/**
 * MFA challenge issuance and verification — PRODUCT_REQUIREMENTS.md §3.16
 * ("MFA mandatory for admin/super_admin, no opt-out").
 *
 * Gap closure (user-reported, live-tested): "the verification code shld be
 * send to the account email to login not a static code." This file used to
 * expose only a fixed `000000` dev-only bypass — no real check existed at
 * all outside a hardcoded string comparison, and nothing was ever emailed.
 * `generateMfaCode`/`hashMfaCode` are now the real thing: a random 6-digit
 * code, actually emailed via the outbox (`service.js`'s `staffLogin`), and
 * actually verified against a stored, hashed, expiring, single-use row
 * (`mfa_login_codes`, `service.js`'s `verifyStaffMfa`) — in every
 * environment, not just outside production. See `errors.js`'s
 * `MfaCodeInvalidError` for the real rejection path a wrong/expired code
 * now takes.
 *
 * This file's OWN job stays narrow: mint and verify the short-lived
 * challenge token `staffLogin` issues instead of full access tokens
 * whenever `roleRequiresMfa`/`user.mfa_enabled` triggers a challenge — the
 * code itself, and its email delivery, live in `service.js`, matching
 * where `requestPasswordReset`/`completePasswordReset` already keep the
 * identical shape of logic for password resets.
 *
 * Real TOTP/authenticator-app enrollment (`mfa_devices.secret`) is still
 * not built — this closes the "no verification exists at all" gap with a
 * real emailed code, not a QR-code/authenticator flow; that remains
 * separate, larger, deferred scope, unchanged by this pass.
 *
 * Platform login (`platformLogin`) never calls `signMfaChallengeToken` — it
 * has no token-issuance path to resume into once "verified" at all yet (see
 * that function's own header), so a platform MFA-verify attempt still
 * falls through to `MfaNotImplementedError`, entirely unchanged by this
 * pass — only the staff path gains real verification.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const CHALLENGE_TTL = '5m';
const CHALLENGE_AUD = 'staff_mfa_challenge';

/** How long an emailed code stays valid — shorter than a password-reset link (1h), matching the "use it right away" nature of an OTP. */
const MFA_CODE_TTL_MINUTES = 10;

/** Wrong guesses a single issued code tolerates before it's treated as spent regardless of what's submitted next — see the migration's own header for why this isn't folded into lockout.js's existing dimensions. */
const MFA_CODE_MAX_ATTEMPTS = 5;

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
 * A real 6-digit numeric code — `crypto.randomInt`, not `Math.random`, for
 * the same "cryptographically strong, not merely plausible-looking"
 * reasoning every other credential in this codebase already follows —
 * plus its SHA-256 digest, the same hash-never-plaintext shape
 * `password_resets`/`guest_password_resets`/`user_invitations` all use.
 * Zero-padded so a code starting with one or more zeros is still exactly
 * 6 digits, never silently shorter.
 */
function generateMfaCode() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  return { code, hash: hashMfaCode(code) };
}

function hashMfaCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

module.exports = {
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  generateMfaCode,
  hashMfaCode,
  MFA_CODE_TTL_MINUTES,
  MFA_CODE_MAX_ATTEMPTS,
};
