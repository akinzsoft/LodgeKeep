/**
 * Builds the URL a brand-new tenant signs in at, from the slug `SignupScreen`
 * just created and the browser's own current location — `tenant-label.js`'s
 * own "derive from the host the browser already has" honesty, run in
 * reverse. There is no backend endpoint that hands back "here is your new
 * tenant's URL" (signup itself doesn't need one — `POST /api/v1/signup`
 * works from any Host header at all, since it's mounted outside
 * `buildStaffRouter()`'s tenant resolution entirely), so this is a plain
 * UI-only guess.
 *
 * A real production bug, user-reported: `APP_DOMAIN` is not always a bare,
 * single-label registrable domain (`lodgekeep.app`) — it can itself be a
 * subdomain (`lodgekeep.planmsys.com`, a real deployment's own value). The
 * OLD version of this function guessed by counting hostname labels — "more
 * than one label, and it's not `localhost`, so the first label must be a
 * tenant subdomain to replace" — which is simply wrong for a multi-label
 * `APP_DOMAIN`: signing up from the bare `lodgekeep.planmsys.com` produced
 * `alpha-motel.planmsys.com` (the real `lodgekeep` label silently stripped
 * off and lost), not `alpha-motel.lodgekeep.planmsys.com`. Label-counting
 * cannot tell "a tenant subdomain in front of a single-label APP_DOMAIN"
 * apart from "no subdomain in front of a multi-label APP_DOMAIN" — both
 * look like ">1 label" from here — so no amount of smarter counting fixes
 * it; the function needs the REAL `APP_DOMAIN` value, not a guess from its
 * own label count.
 *
 * `VITE_APP_DOMAIN` (build-time, threaded through exactly like
 * `VITE_TURNSTILE_SITE_KEY` — `docker/frontend/Dockerfile`'s own ARG,
 * `docker-compose.prod.yml`'s `frontend.build.args`, reusing the same
 * `APP_DOMAIN` value the backend already has, not a second var to keep in
 * sync by hand) is that real value in production. When it's set, the
 * current hostname is checked against it directly — the bare `APP_DOMAIN`
 * itself always gets the slug prefixed onto it VERBATIM, with nothing
 * stripped; an existing tenant subdomain OF it (unusual to sign up from,
 * but not disallowed) gets that one leading label replaced, never nested.
 * Local dev leaves `VITE_APP_DOMAIN` unset (`frontend/.env.example`) — there,
 * this falls back to the old label-counting guess, which is fine precisely
 * because dev's own `APP_DOMAIN` (`localhost`) is single-label and
 * unambiguous.
 *
 * `lodgekeep.planmsys.com` + `VITE_APP_DOMAIN=lodgekeep.planmsys.com`
 *   → `alpha-motel.lodgekeep.planmsys.com` (the bug above, fixed).
 * `alpha-hotels.lodgekeep.planmsys.com` + the same `VITE_APP_DOMAIN`
 *   → `riverside.lodgekeep.planmsys.com` (replaces the one subdomain label,
 *     never `riverside.alpha-hotels.lodgekeep.planmsys.com`).
 * `alpha-hotels.localhost:5173`, no `VITE_APP_DOMAIN` (local dev)
 *   → `riverside.localhost:5173`.
 * `localhost:5173`, no `VITE_APP_DOMAIN` (local dev, the ordinary case)
 *   → `riverside.localhost:5173`.
 */
export function buildTenantLoginUrl(
  slug,
  location = typeof window !== 'undefined' ? window.location : null,
  appDomain = import.meta.env?.VITE_APP_DOMAIN || undefined,
) {
  if (!location) return null;
  const port = location.port ? `:${location.port}` : '';

  if (appDomain) {
    const hostLower = location.hostname.toLowerCase();
    const domainLower = appDomain.toLowerCase();
    if (hostLower === domainLower || hostLower.endsWith(`.${domainLower}`)) {
      return `${location.protocol}//${slug}.${appDomain}${port}/`;
    }
  }

  // No known real APP_DOMAIN to check the hostname against (local dev,
  // where VITE_APP_DOMAIN is deliberately unset) — fall back to the
  // label-counting guess, safe here only because dev's own APP_DOMAIN is
  // always the single, unambiguous label "localhost".
  const labels = location.hostname.split('.');
  const suffix = labels.length > 1 && labels[0] !== 'localhost' ? labels.slice(1).join('.') : location.hostname;
  const host = `${slug}.${suffix}`;
  return `${location.protocol}//${host}${port}/`;
}
