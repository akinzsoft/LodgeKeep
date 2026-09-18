'use strict';

/**
 * Password-reset challenge issuance and verification — gap closure
 * (user-reported): "change the forgot-password flow from an emailed reset
 * link to an emailed numeric code the user types into the app," reusing
 * `src/auth/mfa.js`'s exact pattern rather than inventing a second one.
 *
 * A new file, not an edit to `mfa.js` — that file is scoped to MFA;
 * folding a differently-named, differently-purposed credential flow into
 * it just because the *shape* of the code is identical would couple two
 * unrelated concerns, against this codebase's own file-per-concern
 * convention (`tokens.js`/`roles.js`/`lockout.js`/`refresh-cookie.js`, each
 * its own file).
 *
 * The one real divergence from `mfa.js`'s own shape: the challenge token
 * here carries a `request_id`, not a `userId` — see
 * `20261027090000_create_password_reset_codes.js`'s header for why
 * (anti-enumeration: this token is minted identically whether or not a
 * real account was found, so it can carry nothing that would reveal that).
 *
 * `PASSWORD_RESET_CHALLENGE_TTL` (15m) is deliberately LONGER than
 * `PASSWORD_RESET_CODE_TTL_MINUTES` (10m): if the two matched, a person who
 * takes 11 minutes to find the email would get a confusing "your reset
 * session expired" from the JWT layer in a scenario where the CODE's own
 * `expires_at` — the expiry the user-visible copy actually talks about —
 * is what should be doing the expiring. The extra margin means the code's
 * own database check always fires first, and is the only expiry a user
 * ever needs to reason about.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const CHALLENGE_TTL = '15m';
const CHALLENGE_AUD = 'staff_password_reset_challenge';

/** How long an emailed code stays valid — matches MFA_CODE_TTL_MINUTES's value (mfa.js), an independent constant since the two flows have no shared module to read it from. */
const PASSWORD_RESET_CODE_TTL_MINUTES = 10;

/** Wrong guesses a single issued code tolerates before it's treated as spent regardless of what's submitted next — matches MFA_CODE_MAX_ATTEMPTS's value (mfa.js). See that constant's own comment for why this isn't folded into lockout.js's existing dimensions. */
const PASSWORD_RESET_CODE_MAX_ATTEMPTS = 5;

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error('JWT_SECRET is not set. See .env.example — never fall back to a default in code.');
  }
  return value;
}

/**
 * Issued on every `/password/forgot` call, found or not — carries only a
 * fresh, otherwise-meaningless `request_id`, never a `userId` (see this
 * file's own header). A distinct `aud` so it can never be mistaken for, or
 * accepted as, a real access token or an MFA challenge token.
 */
function signPasswordResetChallengeToken({ tenantId, requestId }) {
  return jwt.sign({ aud: CHALLENGE_AUD, tenant_id: String(tenantId), request_id: requestId }, secret(), {
    expiresIn: CHALLENGE_TTL,
    jwtid: crypto.randomUUID(),
  });
}

/** Throws on an invalid, expired, or wrong-audience token — never returns a partial or best-effort result. */
function verifyPasswordResetChallengeToken(token) {
  const payload = jwt.verify(token, secret());
  if (payload.aud !== CHALLENGE_AUD) {
    throw new jwt.JsonWebTokenError('Not a password-reset challenge token.');
  }
  return payload;
}

/**
 * A real 6-digit numeric code — `crypto.randomInt`, not `Math.random`, the
 * same "cryptographically strong, not merely plausible-looking" reasoning
 * `generateMfaCode` already follows — plus its SHA-256 digest, the same
 * hash-never-plaintext shape every credential in this codebase uses.
 * Zero-padded so a code starting with one or more zeros is still exactly 6
 * digits, never silently shorter.
 */
function generatePasswordResetCode() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  return { code, hash: hashPasswordResetCode(code) };
}

function hashPasswordResetCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

module.exports = {
  signPasswordResetChallengeToken,
  verifyPasswordResetChallengeToken,
  generatePasswordResetCode,
  hashPasswordResetCode,
  PASSWORD_RESET_CODE_TTL_MINUTES,
  PASSWORD_RESET_CODE_MAX_ATTEMPTS,
};
