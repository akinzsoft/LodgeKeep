'use strict';

/**
 * Raw QR-order token generation/encoding — PLAN.md Phase 6. See
 * `pos_order_tokens`' own migration header for why the raw token is
 * stored TWICE, in two different forms (`token_hash` for lookup,
 * `token_encrypted` for re-display), both derived from the exact same raw
 * value generated once, here, at issuance time.
 */

const crypto = require('crypto');
const QRCode = require('qrcode');
const { encrypt, decrypt } = require('../../shared/encryption');

/** 32 random bytes, base64url — url-safe with no padding, so it drops straight into a QR-encoded link with no escaping. */
function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function encryptToken(raw) {
  return encrypt(raw);
}

function decryptToken(encoded) {
  return decrypt(encoded);
}

/**
 * A scannable PNG data URL encoding the guest-ordering URL for this raw
 * token — the same `qrcode` package (and the same "render server-side, no
 * new frontend dependency" reasoning) `src/auth/totp.js` already
 * established for platform MFA enrollment QR codes.
 */
async function renderTokenQrImage(rawToken, { baseUrl }) {
  const url = `${baseUrl.replace(/\/$/, '')}/${rawToken}/menu`;
  return QRCode.toDataURL(url);
}

module.exports = { generateRawToken, hashToken, encryptToken, decryptToken, renderTokenQrImage };
