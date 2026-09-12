/**
 * Builds the URL a brand-new tenant signs in at, from the slug `SignupScreen`
 * just created and the browser's own current location — `tenant-label.js`'s
 * own "derive from the host the browser already has" honesty, run in
 * reverse. There is no backend endpoint that hands back "here is your new
 * tenant's URL" (signup itself doesn't need one — `POST /api/v1/signup`
 * works from any Host header at all, since it's mounted outside
 * `buildStaffRouter()`'s tenant resolution entirely), so this is a plain,
 * same kind of UI-only guess: replace this tab's own first hostname label
 * (if it has one to replace — a bare `localhost` has none) with the new
 * slug, keep the protocol and port exactly as they are.
 *
 * `alpha-hotels.localhost:5173` (signing up from an existing tenant's own
 * subdomain — unusual, but not disallowed) → `riverside.localhost:5173`.
 * `localhost:5173` (signing up from the bare dev origin, the ordinary case)
 * → `riverside.localhost:5173`. `lodgekeep.app` (a real apex marketing
 * domain in production) → `riverside.lodgekeep.app`.
 */
export function buildTenantLoginUrl(slug, location = typeof window !== 'undefined' ? window.location : null) {
  if (!location) return null;
  const labels = location.hostname.split('.');
  const suffix = labels.length > 1 && labels[0] !== 'localhost' ? labels.slice(1).join('.') : location.hostname;
  const host = `${slug}.${suffix}`;
  const port = location.port ? `:${location.port}` : '';
  return `${location.protocol}//${host}${port}/`;
}
