'use strict';

/**
 * Real breached-password screening — PRODUCT_REQUIREMENTS.md §3.16, the
 * gap `password.js`'s own header has flagged since Phase 0: "a data
 * source this pass doesn't wire up." Uses the HaveIBeenPwned "Pwned
 * Passwords" k-anonymity range API — a real, free, no-auth, privacy-
 * preserving check: only the first 5 hex characters of the password's
 * SHA-1 hash ever leave this process, never the password itself or its
 * full hash.
 *
 * Fails OPEN, deliberately: a network failure, timeout, or non-200
 * response never blocks a real signup/password-reset — this is a
 * best-effort defense-in-depth check, not a structural security boundary
 * the way JWT_SECRET/tenant isolation are. Blocking account creation
 * because a third-party API is briefly unreachable would be a worse
 * outcome than occasionally letting a breached password through
 * unchecked — the same "never let an external dependency block a core
 * flow" instinct this codebase already applies to a Paystack refund
 * failure during card-verification cleanup.
 */

const crypto = require('crypto');

const RANGE_API_URL = 'https://api.pwnedpasswords.com/range/';
const REQUEST_TIMEOUT_MS = 2500;

async function isPasswordBreached(plaintext) {
  const sha1 = crypto.createHash('sha1').update(plaintext, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${RANGE_API_URL}${prefix}`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.text();
    return body
      .split('\n')
      .some((line) => line.split(':')[0].trim() === suffix);
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { isPasswordBreached };
