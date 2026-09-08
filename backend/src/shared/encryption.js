'use strict';

/**
 * Encryption at rest for real secrets stored in the database — the first
 * such utility in this codebase. `mfa_devices.secret` has carried a
 * "needs encryption at rest" note since Phase 0 and never got one (still
 * deferred, unrelated to this file); `email_settings.smtp_password_encrypted`
 * (PLAN.md gap closure, "add mail setup to the Setup menu") is the first
 * genuinely secret value this schema stores, so this is built now rather
 * than left as another unclosed TODO.
 *
 * AES-256-GCM: a random 12-byte IV per call (never reused — GCM's security
 * depends on IV uniqueness for a given key), plus GCM's own authentication
 * tag, so a tampered ciphertext fails to decrypt rather than silently
 * producing garbage plaintext. `ENCRYPTION_KEY` is a required env var — a
 * 32-byte key, base64-encoded — checked once at first use, not at process
 * start, so every OTHER route in this app keeps working if a deployment
 * forgets it and never touches an encrypted column.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function loadKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set (see .env.example) — required to encrypt or decrypt a stored secret.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode (base64) to exactly 32 bytes for AES-256-GCM.');
  }
  return key;
}

/** Returns a single self-contained string: base64(iv) + "." + base64(authTag) + "." + base64(ciphertext). */
function encrypt(plaintext) {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

function decrypt(encoded) {
  const key = loadKey();
  const [ivB64, authTagB64, ciphertextB64] = String(encoded).split('.');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted value — expected "iv.authTag.ciphertext".');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
