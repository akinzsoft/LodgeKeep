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
 * `MAX_BYTES` closes a second, related finding — and a real bug in this
 * file's own first attempt at closing it. bcrypt silently truncates its
 * input at 72 BYTES, not 72 characters — a password longer than that
 * hashes identically to its own first-72-bytes prefix, which is confusing
 * at best (two different "long" passwords colliding) and not a real
 * security gain at worst. The first version of this fix capped `.length`
 * (JS string length, i.e. UTF-16 code units) at 128, reasoning "128
 * characters is comfortably past 72 bytes" — that reasoning was simply
 * wrong: 128 ASCII characters is already 128 BYTES, well past 72, so that
 * check never actually protected against bcrypt's own truncation for any
 * password of realistic length, ASCII or not. It was even further off for
 * a password containing multi-byte UTF-8 characters (emoji, accented
 * letters, CJK, Arabic) — a string that reads as short under `.length` can
 * still exceed 72 bytes once encoded, so two genuinely different
 * multi-byte passwords sharing the same first ~72-byte UTF-8 prefix could
 * hash identically while sailing under a character-counted cap the whole
 * time. Fixed by measuring `Buffer.byteLength(plaintext, 'utf8')` directly
 * instead of `.length` — the exact axis bcrypt itself truncates on.
 */

const bcrypt = require('bcrypt');
const { isPasswordBreached } = require('./breached-password');

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 12; // characters — no truncation risk on the low end, so UTF-16 code units are fine here
const MAX_BYTES = 72; // bcrypt's own hard truncation point — UTF-8 BYTES, never JS string length

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
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_BYTES) {
    return {
      code: 'PASSWORD_TOO_LONG',
      message: `Password is too long once encoded (bcrypt truncates beyond ${MAX_BYTES} bytes) — try a shorter passphrase or fewer special characters/emoji.`,
    };
  }
  if (await isPasswordBreached(plaintext)) {
    return { code: 'PASSWORD_BREACHED', message: 'This password has appeared in a known data breach — please choose a different one.' };
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, validatePassword, MIN_LENGTH, MAX_BYTES };
