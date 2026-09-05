'use strict';

/**
 * ULID generation — ARCHITECTURE.md §10 ("UUID/ULID ... safe to expose
 * without revealing sequence/volume information"). Originally built inline
 * in `src/modules/reservations/service.js` for
 * `reservations.confirmation_number`/`folios.folio_number`; moved to shared
 * infra in PLAN.md Phase 2.5 once `payments.provider_reference`
 * (`src/modules/cashiering/service.js`) became the second caller needing
 * the identical guarantee — the same "promoted to shared once a second
 * module needs it" pattern `src/shared/money.js`/`idempotency.js` already
 * followed. Re-exported from `reservations/service.js` unchanged so
 * existing callers and tests are untouched.
 *
 * 48-bit millisecond timestamp (10 base32 chars) + 80 bits of randomness (16
 * base32 chars), Crockford's alphabet. No package dependency added for
 * this: the algorithm is a dozen lines.
 */

const crypto = require('crypto');

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateUlid(now = Date.now(), randomBytes = crypto.randomBytes) {
  let time = BigInt(now);
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = ULID_ALPHABET[Number(time % 32n)] + timePart;
    time /= 32n;
  }

  let random = 0n;
  for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) {
    randomPart = ULID_ALPHABET[Number(random % 32n)] + randomPart;
    random /= 32n;
  }

  return timePart + randomPart;
}

module.exports = { generateUlid };
