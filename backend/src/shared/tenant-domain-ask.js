'use strict';

/**
 * The `ask` endpoint Caddy's `on_demand_tls` global option calls before
 * ever attempting to issue a TLS certificate for a hostname it hasn't seen
 * before (`docker/frontend/Caddyfile`). Caddy GETs this URL with `?domain=`
 * appended automatically; a `200` response means "issue a certificate for
 * this hostname," anything else means "refuse" — live self-service signup
 * (PRODUCT_REQUIREMENTS.md §3.22) means new tenant subdomains appear
 * dynamically, so a static, pre-enumerated Caddyfile block can't work, and
 * without this gate a random/hostile hostname could otherwise trigger
 * unlimited ACME cert requests against this domain's own Let's Encrypt
 * rate limit.
 *
 * Reuses `resolveTenantRowForHostname` (`src/auth/tenant-resolution.js`) —
 * the exact same subdomain-vs-custom-domain lookup a real request's own
 * tenant resolution runs — so "does this hostname deserve a cert" and
 * "does this hostname resolve to a real tenant" can never silently drift
 * into two different answers for the same input.
 *
 * The bare `APP_DOMAIN` itself is a real, deliberate exception to that
 * "must resolve to a tenant" rule — a genuine deployment bug this pass
 * fixes, found live against the real VPS: `/signup` and `/platform` are
 * both mounted in `app.js` with NO tenant resolution at all (confirmed —
 * `signupRouter()`/`buildPlatformRouter()` never call `resolveTenant`),
 * and both are served from this exact bare hostname, not a tenant
 * subdomain (`main.jsx`'s own pathname fork puts `/signup` and `/platform`
 * on the same origin as everything else). `resolveTenantRowForHostname`
 * correctly returns nothing for the bare domain — it isn't a tenant
 * subdomain (`subdomainOf` requires the `.{appDomain}` suffix) and isn't a
 * claimed custom domain either — which left a real chicken-and-egg: an
 * empty database has zero tenants, so the bare domain could never get a
 * certificate, so `/signup` itself (the only way a first tenant could ever
 * come to exist) was unreachable over HTTPS. Allowed unconditionally here,
 * ahead of the tenant lookup, rather than folded into
 * `resolveTenantRowForHostname` itself — that function is also the real
 * per-request tenant resolver (`resolveTenant` middleware), where a
 * request to the bare domain genuinely has no tenant and must keep
 * 404ing; only the TLS question ("should this hostname ever get a cert at
 * all") has a different, wider answer.
 *
 * Never reachable from outside the Docker network in production
 * (`docker-compose.prod.yml` publishes no host port for the `backend`
 * service) — Caddy, on the same compose network, is the only real caller.
 * That network isolation is the actual security boundary; the Redis-backed
 * rate limit below is defense in depth against a flood of distinct fake
 * `domain` values still costing a database round trip each, not the
 * primary control — mirrors the shape `src/modules/qr-ordering/
 * ip-rate-limit.js` already established for the same "Redis-backed,
 * generous ceiling against a runaway/hostile caller" reasoning.
 */

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { rateLimitRedisConnection } = require('./rate-limit-redis-connection');
const { ok, fail } = require('./response');
const { resolveTenantRowForHostname, currentAppDomain } = require('../auth/tenant-resolution');

const MAX_HOSTNAME_LENGTH = 253; // RFC 1035.

function askRateLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,
    store: new RedisStore({
      prefix: 'ask-tls-rl:',
      sendCommand: (...args) => rateLimitRedisConnection().call(...args),
    }),
    handler: (req, res) => res.status(429).json(fail('RATE_LIMITED', 'Too many TLS ask requests.')),
  });
}

function tenantDomainAskRouter({ db, systemContext }) {
  const router = express.Router();

  router.get('/internal/ask-tls', askRateLimiter(), async (req, res) => {
    try {
      const hostname = String(req.query.domain || '').toLowerCase().trim();
      if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) {
        res.status(404).json(fail(null, 'Unknown host.'));
        return;
      }

      const appDomain = currentAppDomain().toLowerCase();
      if (hostname === appDomain) {
        // The platform's own bare domain — /signup and /platform both live
        // here with no tenant to resolve; see this file's own header.
        res.status(200).json(ok({ status: 'ok' }));
        return;
      }

      const scoped = db.for(systemContext());
      const tenantRow = await resolveTenantRowForHostname({ scoped, hostname, appDomain });

      if (!tenantRow) {
        res.status(404).json(fail(null, 'Unknown host.'));
        return;
      }
      res.status(200).json(ok({ status: 'ok' }));
    } catch (error) {
      // Deny on any unexpected failure — a false negative just means Caddy
      // declines to issue a cert on this one attempt (safe; it retries on
      // the next real connection). A false positive would be the one that
      // actually matters, so an error never falls through to a 200.
      res.status(500).json(fail('INTERNAL_ERROR', 'Ask check failed.'));
    }
  });

  return router;
}

module.exports = { tenantDomainAskRouter };
