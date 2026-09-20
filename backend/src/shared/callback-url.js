'use strict';

/**
 * Security fix — `callback_url` was passed straight through to Paystack,
 * unvalidated, at three call sites: cashiering's guest-payment checkout
 * (`cashiering/controller.js`), billing's add-payment-method checkout
 * (`billing/controller.js`), and qr-ordering's guest checkout
 * (`qr-ordering/controller.js`) — the last of which is fully public, no
 * authentication of any kind, making it the most directly exploitable of
 * the three.
 *
 * An attacker-controlled `callback_url` is a classic open redirect:
 * Paystack redirects the browser there once checkout completes (appending
 * the transaction reference as a query param), so a forged URL both
 * phishes more convincingly than a bare phishing link (it starts on
 * Paystack's own real checkout page and only redirects to the attacker's
 * site at the very end) and leaks the transaction reference to an
 * attacker-controlled origin.
 *
 * `assertAllowedCallbackUrl` accepts a callback only when its origin
 * genuinely belongs to the CALLING tenant — its default
 * `{slug}.APP_DOMAIN` subdomain, or a `tenant_domains` row for it that has
 * actually been DNS-verified (`verified_at IS NOT NULL`). A missing/blank
 * `callback_url` is left alone — every one of these three call sites
 * already treats it as optional, and Paystack falls back to its own
 * dashboard-configured default when none is supplied.
 *
 * ── RE-REVIEW FIX: VERIFIED DOMAINS ONLY ─────────────────────────────────
 * This originally also accepted an UNVERIFIED `tenant_domains` claim,
 * reasoning (wrongly, for this specific check) that
 * `src/auth/tenant-resolution.js` already trusts an unverified claim for
 * the identical-SOUNDING "does this hostname belong to this tenant"
 * question. The two checks are not actually identical: Host-header
 * resolution is gated by DNS in practice — a browser only ever SENDS that
 * Host header to this server if the hostname's own DNS already points
 * here, so an attacker claiming a domain they don't control gains nothing
 * (no real traffic for that hostname ever reaches this server to
 * "resolve"). A client-supplied `callback_url` has no such gate — nothing
 * stops a tenant from typing in a domain string it does not actually
 * control (`tenant_domains.domain` accepts any string; verification is a
 * real, separate DNS TXT challenge, still unbuilt) and having Paystack
 * redirect a real browser there anyway, defeating the entire point of this
 * check. Only a genuinely DNS-verified custom domain, or the tenant's own
 * platform-issued default subdomain, is trusted now.
 *
 * Lives in `src/shared`, not any one module, since all three business
 * modules above need the identical check and none of them may depend on
 * another (CLAUDE.md's module-boundary rule).
 */

const { ValidationError } = require('./errors');

function invalidCallbackUrlError() {
  return new ValidationError('INVALID_CALLBACK_URL', 'The supplied callback_url does not belong to this organization.', [{ field: 'callback_url', issue: 'not_allowed' }]);
}

/**
 * @param {object} db - a context-bound accessor (`scopedDb().for(context)`,
 *   or the accessor handed into a `db.transaction()` callback) for the
 *   CALLING tenant — `tenants`/`tenant_domains` are both read scoped to it,
 *   never to a caller-supplied tenant id.
 * @param {{callbackUrl: string|null|undefined}} params
 * @returns {Promise<void>} resolves if `callbackUrl` is absent or allowed; throws `ValidationError` otherwise.
 */
async function assertAllowedCallbackUrl(db, { callbackUrl }) {
  if (!callbackUrl) return;

  let parsed;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw invalidCallbackUrlError();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidCallbackUrlError();
  }

  const hostname = parsed.hostname.toLowerCase();

  const appDomain = process.env.APP_DOMAIN;
  if (appDomain) {
    const tenant = await db.table('tenants').first('slug');
    if (tenant && hostname === `${tenant.slug}.${appDomain}`.toLowerCase()) return;
  }

  const claimedDomain = await db.table('tenant_domains').where({ domain: hostname }).whereNotNull('verified_at').first('id');
  if (claimedDomain) return;

  throw invalidCallbackUrlError();
}

module.exports = { assertAllowedCallbackUrl };
