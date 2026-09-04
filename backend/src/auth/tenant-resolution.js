'use strict';

/**
 * Tenant resolution from the request's Host header — PRODUCT_REQUIREMENTS.md
 * §3.16, resolved (this pass) as: staff login determines `tenant_id` from
 * where the request arrived, before any query runs. Never from the request
 * body — a `tenant_id` or `tenant_slug` a client could simply type in would be
 * exactly the attack SECURITY.md §2 describes for a URL/body/header tenant_id,
 * just moved into the login payload instead of the URL.
 *
 * Two real sources, both resolved through the accessor's bootstrap path
 * (`src/modules/tenancy/scoped-db.js`) because both are, structurally, "look
 * this global-unique value up before a tenant context exists":
 *
 *   {slug}.APP_DOMAIN   the default subdomain every tenant gets, straight off
 *                       `tenants.slug`.
 *   any other host      looked up in `tenant_domains` (a tenant's own custom
 *                       domain, once claimed) for its `tenant_id`, then
 *                       `tenants` by that id for the row itself — the second
 *                       hop `tenants`'s `id` bootstrap column exists for.
 *
 * ── LOCAL DEV / TEST OVERRIDE ─────────────────────────────────────────────
 *
 * Real subdomains need DNS most local and CI environments don't have. Outside
 * `production`, an `X-Tenant-Slug` header takes precedence over the Host
 * header entirely — a header rather than a path prefix because it changes
 * nothing about the route tree or the URLs a frontend built against
 * production would use, it only swaps out how one middleware decides
 * `tenant_id` before that frontend runs against a machine with no real DNS.
 * Gated on `NODE_ENV !== 'production'` so it can never matter outside dev/test.
 */

const { fail } = require('../shared/response');

function currentAppDomain() {
  const value = process.env.APP_DOMAIN;
  if (!value) throw new Error('APP_DOMAIN is not set. See .env.example.');
  return value;
}

function subdomainOf(hostname, appDomain) {
  const suffix = `.${appDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const subdomain = hostname.slice(0, -suffix.length);
  // A bare second-level match ("lodgekeep.app" itself, or an empty label from
  // "..lodgekeep.app") is not a tenant subdomain.
  if (!subdomain || subdomain.includes('.')) return null;
  return subdomain;
}

async function resolveByCustomDomain(scoped, hostname) {
  const domainRow = await scoped.bootstrap('tenant_domains', hostname);
  if (!domainRow) return null;
  return scoped.bootstrap('tenants', 'id', domainRow.tenant_id);
}

/**
 * Resolves `req.tenantId` from the Host header (or the dev override) before
 * any route handler runs. A request whose host resolves to no tenant, or
 * resolves to one that is not `active`, gets the bare 404 API.md §5 uses for
 * "does not exist" — deliberately indistinguishable from any other unresolved
 * lookup, so probing hostnames reveals nothing.
 */
function resolveTenant({ db, systemContext }) {
  return async function resolveTenantMiddleware(req, res, next) {
    try {
      const scoped = db.for(systemContext());
      const devOverride = process.env.NODE_ENV !== 'production' ? req.get('X-Tenant-Slug') : null;

      let tenantRow;
      if (devOverride) {
        tenantRow = await scoped.bootstrap('tenants', 'slug', devOverride);
      } else {
        const subdomain = subdomainOf(req.hostname, currentAppDomain());
        tenantRow = subdomain
          ? await scoped.bootstrap('tenants', 'slug', subdomain)
          : await resolveByCustomDomain(scoped, req.hostname);
      }

      if (!tenantRow || tenantRow.status !== 'active') {
        res.status(404).json(fail(null, 'Not found.', { requestId: req.requestId }));
        return;
      }

      req.tenantId = String(tenantRow.id);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { resolveTenant, subdomainOf };
