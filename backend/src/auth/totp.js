'use strict';

/**
 * TOTP (RFC 6238) generation/verification for platform-staff MFA — PLAN.md
 * Phase 5 (Platform Foundation), SECURITY.md §1.1 ("no long-lived tokens
 * for privileged roles"). `platform_users.mfa_secret` has carried a
 * "TOTP, encrypted at rest" comment since Phase 0 and never had a writer
 * until this pass.
 *
 * Confirmed decision: real authenticator-app TOTP now, not a dev-only
 * bypass — this is the gateway to impersonating any tenant, so it gets
 * stronger verification than an ordinary staff login, not weaker.
 *
 * `otplib` is this codebase's first TOTP dependency, added purely for this
 * one real capability, the same "one new dependency, one real capability"
 * precedent `nodemailer` already established for real SMTP delivery.
 * Deliberately pinned to the v12 line (the classic, synchronous
 * `authenticator` namespace), not the newer v13 rewrite: v13's default
 * base32/crypto plugins transitively pull in `@scure/base`, a pure-ESM
 * package Jest's CommonJS transform cannot load (`require()` of it throws
 * "Must use import to load ES Module") — confirmed live, this codebase's
 * test suite failed to even boot with v13 installed. v12 has no such
 * dependency and needs no `transformIgnorePatterns`/babel changes to this
 * project's existing Jest config. `qrcode` renders the enrollment
 * `otpauth://` URI as a scannable PNG data URL, kept server-side so the
 * frontend needs no new dependency of its own.
 *
 * Pure and directly unit-testable — no database, no encryption — mirroring
 * `tax-engine.js`'s own "pure, proven at every boundary before anything
 * touches the database" discipline. `service.js` is the only caller, and
 * the only place that ever touches ciphertext (via `shared/encryption.js`).
 */

const { authenticator } = require('otplib');
const QRCode = require('qrcode');

authenticator.options = { issuer: process.env.PLATFORM_MFA_ISSUER || 'LodgeKeep Platform' };

/** A fresh base32 TOTP secret — plaintext; the caller encrypts before persisting. */
function generateTotpSecret() {
  return authenticator.generateSecret();
}

/** The `otpauth://` URI an authenticator app scans/imports — never persisted, shown once at enrollment time. */
function buildOtpAuthUrl({ secretPlaintext, accountLabel }) {
  return authenticator.keyuri(accountLabel, authenticator.options.issuer, secretPlaintext);
}

/** A scannable PNG, as a `data:` URL — no separate asset/route needed to serve it. */
async function generateQrCodeDataUrl(otpAuthUrl) {
  return QRCode.toDataURL(otpAuthUrl);
}

/** Accept the current 30-second step only; persist it to reject reuse. */
function verifiedTotpStep({ secretPlaintext, code }) {
  if (!/^\d{6}$/.test(String(code ?? ''))) return null;
  const epoch = Date.now();
  const verifier = authenticator.clone({ epoch, step: 30, window: 0 });
  try {
    return verifier.check(String(code), secretPlaintext) ? Math.floor(epoch / 30000) : null;
  } catch {
    return null;
  }
}

module.exports = { generateTotpSecret, buildOtpAuthUrl, generateQrCodeDataUrl, verifiedTotpStep };
