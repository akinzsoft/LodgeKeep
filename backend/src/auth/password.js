'use strict';

/**
 * Password hashing and policy — SECURITY.md §1.1, PRODUCT_REQUIREMENTS.md
 * §3.16 ("enforce a minimum length rather than composition rules — a long
 * passphrase beats forced symbols").
 *
 * Security-review finding, closed: breached-password screening (§3.16's
 * other requirement) is real now — `breached-password.js`'s own header has
 * the full reasoning (a k-anonymity HaveIBeenPwned lookup, fails open).
 * `validatePassword` is therefore async — every call site now awaits it.
 *
 * `MAX_LENGTH` closes a second, related finding: bcrypt silently truncates
 * its input at 72 BYTES — a password longer than that hashes identically
 * to its own first-72-bytes prefix, which is confusing at best (two
 * different "long" passwords colliding) and not a real security gain at
 * worst. 128 characters is comfortably past 72 bytes for any real
 * passphrase while still being password-manager-friendly (most generators
 * default to 16-32 characters).
 */

const bcrypt = require('bcrypt');
const { isPasswordBreached } = require('./breached-password');

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Length, a sane maximum, and a real breached-password check, per §3.16.
 * Returns `{ code, message }` (`code` one of `PASSWORD_TOO_SHORT`,
 * `PASSWORD_TOO_LONG`, `PASSWORD_BREACHED` — every call site throws
 * `new ValidationError(issue.code, issue.message)`), or `null` when the
 * password is acceptable.
 *
 * A real, minor bug this pass found and fixed while adding the two new
 * failure reasons above: every one of this function's five call sites
 * used to hardcode `'PASSWORD_TOO_SHORT'` regardless of which check
 * actually failed — harmless while length was the only possible reason,
 * but a genuinely misleading error code the moment a "too long" or
 * "breached" rejection could happen too. `code` now travels with the
 * issue instead of being guessed at the call site.
 */
async function validatePassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length < MIN_LENGTH) {
    return { code: 'PASSWORD_TOO_SHORT', message: `Password must be at least ${MIN_LENGTH} characters.` };
  }
  if (plaintext.length > MAX_LENGTH) {
    return { code: 'PASSWORD_TOO_LONG', message: `Password must be at most ${MAX_LENGTH} characters.` };
  }
  if (await isPasswordBreached(plaintext)) {
    return { code: 'PASSWORD_BREACHED', message: 'This password has appeared in a known data breach — please choose a different one.' };
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, validatePassword, MIN_LENGTH, MAX_LENGTH };
