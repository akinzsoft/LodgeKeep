'use strict';

/**
 * Security-review finding: `JWT_SECRET`/`ENCRYPTION_KEY` were both
 * validated lazily — only checked the first time something actually
 * needed them (`auth/tokens.js`'s own `secret()`, `encryption.js`'s own
 * `loadKey()`) — so a container could start, report `/healthz` healthy
 * (that check deliberately validates MySQL connectivity only — see its
 * own header for why that scope is intentional, unchanged here), and only
 * surface a missing/malformed secret on whichever real request happened
 * to need it first — a real login, or a real email-settings save.
 *
 * This is the fail-fast counterpart: called once from `server.js` before
 * the process ever starts listening, so a misconfigured deployment never
 * comes up looking healthy. Deliberately does NOT hard-require payment
 * gateway or SMTP credentials — those are genuinely optional, per-tenant-
 * configurable integrations this codebase has always treated as "flagged,
 * not invented" gaps (`paystack-adapter.js`, `email-adapter.js` — both
 * already fail clearly, at the point of use, with an honest
 * `PAYMENT_GATEWAY_NOT_CONFIGURED`/`SMTP_HOST is required` error rather
 * than a silent no-op), never a reason to block the whole app from
 * starting.
 *
 * Reuses the REAL code paths (`signAccessToken`, `encrypt`/`decrypt`)
 * rather than duplicating their own validation logic — a throwaway sign
 * and a round-tripped encrypt/decrypt at boot exercise the exact checks a
 * real request would hit, so this can never silently drift from what
 * actually gets validated at request time.
 *
 * `TURNSTILE_SECRET_KEY` (CAPTCHA screening on `POST /signup`,
 * `shared/captcha-verify.js`) joined this list as a REQUIRED var, unlike
 * Paystack/SMTP — an unprotected public, tenant-creating endpoint is a
 * structural risk the confirmed design fails CLOSED on, not an optional
 * integration. Unlike the two checks above, this is presence-only, not a
 * functional round-trip: proving the key actually WORKS needs a live call
 * to Cloudflare paired with a real response token, and a secret key alone
 * proves nothing — a network call to a third party on every process boot
 * would also cut against this file's own instinct (above) of never letting
 * an external dependency block startup, which the CAPTCHA case deliberately
 * overrides at request time (`captcha-verify.js`'s own header) but has no
 * reason to also apply at boot time, where the value can't yet be tested
 * against anything.
 */

const { signAccessToken } = require('../auth/tokens');
const { encrypt, decrypt } = require('./encryption');

function validateStartupConfig() {
  const problems = [];

  try {
    signAccessToken({ aud: 'startup-check', sub: '0', tenant_id: '0' });
  } catch (error) {
    problems.push(`JWT_SECRET — ${error.message}`);
  }

  try {
    const roundTripped = decrypt(encrypt('startup-check'));
    if (roundTripped !== 'startup-check') {
      problems.push('ENCRYPTION_KEY — round-trip produced a different value than was encrypted.');
    }
  } catch (error) {
    problems.push(`ENCRYPTION_KEY — ${error.message}`);
  }

  if (!process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY.trim() === '') {
    problems.push('TURNSTILE_SECRET_KEY — required (CAPTCHA screening on public signup); refusing to start without it.');
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start — required security configuration is missing or invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`
    );
  }
}

module.exports = { validateStartupConfig };
