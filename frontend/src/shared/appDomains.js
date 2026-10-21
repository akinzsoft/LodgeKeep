/**
 * The app domains this build knows about: ONE primary (`VITE_APP_DOMAIN`) and any additional accepted ones
 * (`VITE_ADDITIONAL_APP_DOMAINS`, comma-separated). Mirrors the backend's `src/shared/app-domains.js` rules, so the
 * two agree on what a tenant host is: exactly one label in front of an accepted domain.
 *
 * A value with a scheme, port, path, wildcard, space or an empty label is DROPPED (never repaired), so a typo can only
 * narrow what is accepted. Nothing configured means nothing is accepted, which only ever hides the landing page.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function clean(raw) {
  const value = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!value || !value.split('.').every((label) => LABEL.test(label))) return null;
  return value;
}

/** `{ primary, all }`; `primary` is null when none is configured. */
export function parseAppDomains(primaryRaw, additionalRaw) {
  const primary = clean(primaryRaw);
  const all = primary ? [primary] : [];
  for (const piece of String(additionalRaw ?? '').split(',')) {
    const domain = clean(piece);
    if (domain && !all.includes(domain)) all.push(domain);
  }
  return { primary, all };
}

/** The build's own domains, read from the Vite env. */
export function configuredAppDomains() {
  return parseAppDomains(import.meta.env?.VITE_APP_DOMAIN, import.meta.env?.VITE_ADDITIONAL_APP_DOMAINS);
}

/** True when `hostname` is exactly an accepted bare domain, or exactly `{one label}.{an accepted domain}`. */
export function isAcceptedAppHost(hostname, domains) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  return domains.some((domain) => {
    if (host === domain) return true;
    if (!host.endsWith(`.${domain}`)) return false;
    const label = host.slice(0, -(domain.length + 1));
    return Boolean(label) && !label.includes('.');
  });
}
