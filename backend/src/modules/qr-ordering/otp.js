'use strict';

/**
 * The room-charge one-time code — PLAN.md Phase 6, mirroring
 * `src/auth/mfa.js`'s `generateMfaCode`/`hashMfaCode` shape-for-shape (see
 * `pos_room_charge_otps`' own migration header for the full reasoning).
 * Kept as this module's own file, not imported from `src/auth/mfa.js`,
 * since that file's own header scopes it explicitly to staff login
 * challenges — a second, unrelated caller reusing its exact shape (not its
 * code) is the "promote once genuinely shared, duplicate a small pure
 * function otherwise" judgment call `resolveActivePlanId`/`resolvePlanFor`
 * already made once in this codebase for an identical-shaped, differently-
 * owned query.
 */

const crypto = require('crypto');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

function generateOtpCode() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  return { code, hash: hashOtpCode(code) };
}

function hashOtpCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

module.exports = { generateOtpCode, hashOtpCode, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS };
