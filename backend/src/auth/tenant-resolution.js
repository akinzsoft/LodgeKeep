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
 * any route handler runs. A request whose host resolves to no tenant at all
 * gets a 404, still API.md §5's own status code for "does not exist" — but
 * with a real, human-readable message rather than the generic `notFound()`
 * helper's bare "Not found." (user-reported: that string means nothing to a
 * person who has simply mistyped or bookmarked the wrong address, and this
 * is very often the very first thing a real visitor sees, on the login
 * screen itself). This is a genuinely different situation from the one
 * `notFound()` exists to protect — that helper's "indistinguishable from any
 * other unresolved lookup" reasoning is about a record INSIDE an
 * already-resolved tenant possibly belonging to someone else, where the
 * wording must never hint "exists, but not yours" apart from "does not
 * exist at all." Host resolution runs before ANY tenant or auth context
 * exists — there is no cross-tenant record to accidentally confirm, so a
 * clearer message here costs nothing: it still says nothing about whether
 * any OTHER address is a real tenant, only that THIS one resolved to none.
 *
 * PLAN.md Phase 5 gap closure: this used to require `status === 'active'`,
 * which meant a `trial`-status tenant — the schema's own default, so every
 * tenant that has EVER existed the moment it's created — could not reach
 * login at all. That directly contradicted PRODUCT_REQUIREMENTS.md §3.22's
 * "trial tenants must be fully usable while the trial is valid" and
 * `tenants.status`'s own migration comment ("degrades to read-only, never a
 * hard lockout"). `trial` and `suspended` must both resolve normally here —
 * reachability and write access are separate questions; WHICH writes a
 * suspended or trial-expired tenant may perform is
 * `src/auth/tenant-lifecycle-guard.js`'s job, checked per-request after
 * authentication, not this one-time Host-header lookup.
 *
 * PLAN.md Phase 5 (tenant offboarding): `offboarding` used to be the one
 * status that stayed a hard 404 here — confirmed with the user before
 * changing it, the same "check what a status currently does before
 * building on it" discipline the signup pass applied to `trial`. That
 * blanket block predates any real offboarding flow ever existing (nothing
 * transitioned into the status until this pass), and it is actively wrong
 * for the flow this pass builds: a tenant who has just requested their own
 * account closure must still be able to log in to see their request's
 * status and download the data export PRODUCT_REQUIREMENTS.md §3.22
 * requires — a bare 404 would make that self-service screen unreachable by
 * the very account it belongs to. `offboarding` now resolves exactly like
 * `trial`/`suspended`: reachable, with WRITE access blocked by
 * `isTenantWriteBlocked`/`tenant-lifecycle-guard.js` exactly like those two
 * (that function has treated `offboarding` as write-blocked since the
 * signup pass — see its own header — this is the first request path that
 * can actually reach that branch with a real `offboarding` tenant).
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

      if (!tenantRow) {
        // `code: null`, matching every other 404 in this codebase (API.md
        // §3: 404 carries no code prefix at all, by design) — only the
        // MESSAGE improves here, not the machine-readable shape.
        res.status(404).json(fail(null, 'No organization is registered at this address.', { requestId: req.requestId }));
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
