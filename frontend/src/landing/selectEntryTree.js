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

/**
 * True only for the exact bare host of an accepted app domain: the primary (`VITE_APP_DOMAIN`) or any additional one
 * (`VITE_ADDITIONAL_APP_DOMAINS`, comma-separated). Exact equality each, never a suffix match.
 */
export function isMarketingHost(hostname, appDomain, additionalDomains) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  const domains = [appDomain, ...String(additionalDomains ?? '').split(',')].map(normalizeHost).filter(Boolean);
  return domains.includes(host);
}

/**
 * @param {{hostname: string, pathname: string, appDomain?: string, additionalDomains?: string}} where
 * @returns {'landing'|'portal'|'platform'|'qr-order'|'signup'|'app'}
 */
export function selectEntryTree({ hostname, pathname, appDomain, additionalDomains }) {
  if (pathname === '/' && isMarketingHost(hostname, appDomain, additionalDomains)) return 'landing';
  // The same order and prefix checks `main.jsx` has always used (so /portalx is the portal too).
  if (pathname.startsWith('/portal')) return 'portal';
  if (pathname.startsWith('/platform')) return 'platform';
  if (pathname.startsWith('/qr-order')) return 'qr-order';
  if (pathname.startsWith('/signup')) return 'signup';
  return 'app';
}
