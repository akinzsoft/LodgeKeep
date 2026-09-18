'use strict';

/**
 * Real CAPTCHA screening for `POST /signup` — security-review finding
 * ("distributed bots can use many IPs" to route around the per-IP/per-
 * account rate limiter alone). Cloudflare Turnstile, verified server-side
 * against Cloudflare's own `siteverify` endpoint.
 *
 * Structurally the same shape as `breached-password.js` (a plain,
 * dependency-light `fetch` call with an `AbortController` timeout) but
 * with the OPPOSITE fail mode, stated loudly here on purpose:
 * `isPasswordBreached` fails OPEN because it is defense-in-depth on top of
 * a length requirement that already exists; this fails CLOSED — a
 * network error, timeout, non-200, or `success: false` all mean "not
 * verified," never "assume it's fine." A public, tenant-creating endpoint
 * with no CAPTCHA proof is exactly the abuse surface this check exists to
 * close, so a Cloudflare outage degrading to "signup is temporarily
 * unavailable" is the correct trade — not "signup is temporarily
 * unprotected."
 *
 * `TURNSTILE_SECRET_KEY` is a REQUIRED env var, unlike Paystack/SMTP's
 * optional-and-flagged credentials — `shared/startup-checks.js` refuses to
 * start the process at all without it, so the `if (!secret)` branch below
 * is defensive only, never the normal path in a real deployment. Dev/test
 * use Cloudflare's own official "always passes" dummy secret key
 * (`1x0000000000000000000000000000000AA`, documented at
 * developers.cloudflare.com/turnstile/troubleshooting/testing/) — never a
 * bypass this codebase invents itself.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const REQUEST_TIMEOUT_MS = 2500;

async function verifyTurnstileToken(token, { remoteIp } = {}) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ secret, response: String(token) });
    if (remoteIp) body.set('remoteip', remoteIp);
    const response = await fetch(VERIFY_URL, { method: 'POST', body, signal: controller.signal });
    if (!response.ok) return false;
    const json = await response.json();
    return json?.success === true;
  } catch (error) {
    // Code-review finding: this fails closed and blocks real signups on
    // any Cloudflare hiccup — a totally silent failure would make an
    // outage invisible in production logs until users report "I can't
    // sign up." Logged, not swallowed, matching this codebase's own
    // failure-visibility convention elsewhere (e.g. `email-adapter.js`).
    console.error('Turnstile verification request failed:', error);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { verifyTurnstileToken };
