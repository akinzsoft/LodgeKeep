'use strict';

/**
 * Password hashing and policy — SECURITY.md §1.1, PRODUCT_REQUIREMENTS.md
 * §3.16 ("enforce a minimum length rather than composition rules — a long
 * passphrase beats forced symbols").
 *
 * Breached-password list checking (§3.16's other requirement) needs a data
 * source this pass doesn't wire up — a local corpus or an HaveIBeenPwned-style
 * k-anonymity API call — and is deferred rather than faked; `validatePassword`
 * says so in its own comment so the gap stays visible rather than silently
 * "passing" every password.
 */

const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 12;

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Length only, per §3.16's explicit preference. Returns an issue string, or
 * null when the password is acceptable.
 *
 * Breached-password checking is NOT performed here yet — see file header.
 */
function validatePassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, validatePassword, MIN_LENGTH };
