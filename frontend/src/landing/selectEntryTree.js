/**
 * Which top-level tree the browser should render — the one decision
 * `main.jsx` makes before any app code runs.
 *
 * The marketing landing page is shown ONLY when the page is served from the
 * EXACT bare app domain (e.g. `lodgekeep.planmsys.com`) at the path `/`.
 * Every other host — each tenant subdomain (`alpha-motel.lodgekeep.planmsys.com`,
 * a future `anything.lodgekeep.planmsys.com`), a customer's own custom domain,
 * an IP address — takes exactly the path the app has always taken, so a
 * tenant's login can never be replaced by it.
 *
 * Deliberately a POSITIVE match, never "anything that is not a tenant":
 *   - exact equality after lower-casing (and dropping one trailing dot, which
 *     DNS allows); never `endsWith`/`includes`, so `x.lodgekeep.planmsys.com`,
 *     `lodgekeep.planmsys.com.evil.com` and `evillodgekeep.planmsys.com` are
 *     all NOT the marketing host;
 *   - it compares `location.hostname`, which carries no port;
 *   - with no app domain configured (`VITE_APP_DOMAIN` empty) nothing matches,
 *     so a mis-built bundle can only ever hide the landing page, never take a
 *     tenant's login away.
 *
 * `/signup`, `/platform`, `/portal*` and `/qr-order*` keep working on the bare
 * host: the landing page owns the path `/` and nothing else.
 */

/** Lower-case, drop one trailing dot ("Host.Example." → "host.example"). */
function normalizeHost(host) {
  return String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** True only for the exact bare app domain. */
export function isMarketingHost(hostname, appDomain) {
  const domain = normalizeHost(appDomain);
  if (!domain) return false;
  return normalizeHost(hostname) === domain;
}

/**
 * @param {{hostname: string, pathname: string, appDomain?: string}} where
 * @returns {'landing'|'portal'|'platform'|'qr-order'|'signup'|'app'}
 */
export function selectEntryTree({ hostname, pathname, appDomain }) {
  if (pathname === '/' && isMarketingHost(hostname, appDomain)) return 'landing';
  // The same order and prefix checks `main.jsx` has always used (so /portalx is the portal too).
  if (pathname.startsWith('/portal')) return 'portal';
  if (pathname.startsWith('/platform')) return 'platform';
  if (pathname.startsWith('/qr-order')) return 'qr-order';
  if (pathname.startsWith('/signup')) return 'signup';
  return 'app';
}
