'use strict';

/**
 * The domains this deployment answers on. One PRIMARY domain (`PRIMARY_APP_DOMAIN`, falling back to `APP_DOMAIN`, so with
 * nothing new set this is exactly the single domain it always was) and any number of ADDITIONAL accepted ones
 * (`ADDITIONAL_APP_DOMAINS`, comma-separated).
 *
 *   - INCOMING requests are accepted on every one of them: a tenant lives at `{slug}.{any accepted domain}`, and each
 *     bare domain serves `/signup`, `/platform` and the landing page.
 *   - OUTGOING links (invitations, guest password resets, the signup redirect) always use the primary.
 *
 * Matching is exact: ONE label in front of an accepted domain and nothing else. `x.lodgekeep.ng.evil.com`,
 * `evillodgekeep.ng`, `a.b.lodgekeep.ng` and `lodgekeep.ng.evil.com` are not tenant hosts. A value is rejected (not
 * silently fixed) when it has a scheme, port, path, wildcard, spaces or an empty label, so a typo cannot widen what is
 * accepted.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

class AppDomainConfigError extends Error {
  constructor(variable, value, reason) {
    super(`${variable} has an invalid domain "${value}": ${reason}. Use a bare host name such as lodgekeep.ng (no scheme, port, path or wildcard).`);
    this.name = 'AppDomainConfigError';
  }
}

/** Lowercases and trims one domain and rejects anything that is not a plain host name. */
function normaliseDomain(raw, variable = 'APP_DOMAIN') {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) throw new AppDomainConfigError(variable, raw, 'it is empty');
  if (value.includes('://')) throw new AppDomainConfigError(variable, value, 'it has a scheme');
  if (value.includes('*')) throw new AppDomainConfigError(variable, value, 'it has a wildcard');
  if (value.includes('/') || value.includes('?') || value.includes('#')) throw new AppDomainConfigError(variable, value, 'it has a path');
  if (value.includes(':')) throw new AppDomainConfigError(variable, value, 'it has a port');
  if (/\s/.test(value)) throw new AppDomainConfigError(variable, value, 'it has spaces');
  if (!value.split('.').every((label) => LABEL.test(label))) throw new AppDomainConfigError(variable, value, 'it has an empty or invalid label');
  return value;
}

/** `{ primary, additional, all }`, read from the environment on each call (cheap, and tests change it). Throws AppDomainConfigError. */
function appDomains(env = process.env) {
  const rawPrimary = (env.PRIMARY_APP_DOMAIN ?? '').trim() ? env.PRIMARY_APP_DOMAIN : env.APP_DOMAIN;
  if (!rawPrimary || !String(rawPrimary).trim()) throw new Error('APP_DOMAIN is not set. See .env.example.');
  const primary = normaliseDomain(rawPrimary, (env.PRIMARY_APP_DOMAIN ?? '').trim() ? 'PRIMARY_APP_DOMAIN' : 'APP_DOMAIN');
  const additional = [];
  for (const piece of String(env.ADDITIONAL_APP_DOMAINS ?? '').split(',')) {
    if (!piece.trim()) continue;
    const domain = normaliseDomain(piece, 'ADDITIONAL_APP_DOMAINS');
    if (domain !== primary && !additional.includes(domain)) additional.push(domain);
  }
  // The old APP_DOMAIN stays accepted when it is not the primary (the point of a transition): it is listed explicitly
  // in ADDITIONAL_APP_DOMAINS, never added silently.
  return { primary, additional, all: [primary, ...additional] };
}

/** The tenant slug when `hostname` is exactly `{one label}.{an accepted domain}`, else null. */
function matchTenantSubdomain(hostname, env = process.env) {
  const host = String(hostname ?? '').toLowerCase();
  for (const domain of appDomains(env).all) {
    const suffix = `.${domain}`;
    if (!host.endsWith(suffix)) continue;
    const label = host.slice(0, -suffix.length);
    if (label && !label.includes('.')) return label;
  }
  return null;
}

/** True when `hostname` is exactly one of the accepted bare domains. */
function isBareAppDomain(hostname, env = process.env) {
  return appDomains(env).all.includes(String(hostname ?? '').toLowerCase());
}

/** The URL a tenant is reached at in outgoing mail: always https, always the primary domain. */
function tenantBaseUrl(slug, env = process.env) {
  return `https://${slug}.${appDomains(env).primary}`;
}

/**
 * The two lifecycle domains: where a tenant lives while on trial and once subscribed. Each defaults to the primary
 * (so nothing changes until they are set) and must be one of the accepted domains, otherwise it is a config error
 * (a link to a domain the server does not answer on would be a dead link in every email).
 */
function lifecycleDomains(env = process.env) {
  const { primary, all } = appDomains(env);
  const pick = (variable) => {
    const raw = (env[variable] ?? '').trim();
    if (!raw) return primary;
    const domain = normaliseDomain(raw, variable);
    if (!all.includes(domain)) throw new AppDomainConfigError(variable, domain, 'it is not one of the accepted app domains (PRIMARY_APP_DOMAIN / ADDITIONAL_APP_DOMAINS)');
    return domain;
  };
  return { trial: pick('TRIAL_APP_DOMAIN'), subscribed: pick('SUBSCRIBED_APP_DOMAIN') };
}

/** The domain a tenant row is reached at in outgoing mail: its stored `app_domain` while that is still accepted, else the primary. */
function tenantDomainFor(tenant, env = process.env) {
  const { primary, all } = appDomains(env);
  const stored = String(tenant?.app_domain ?? '').trim().toLowerCase();
  return stored && all.includes(stored) ? stored : primary;
}

/** `https://{slug}.{the tenant's own domain}` — pass the tenants row (`slug`, `app_domain`). */
function tenantBaseUrlFor(tenant, env = process.env) {
  return `https://${tenant.slug}.${tenantDomainFor(tenant, env)}`;
}

module.exports = { AppDomainConfigError, normaliseDomain, appDomains, matchTenantSubdomain, isBareAppDomain, tenantBaseUrl, lifecycleDomains, tenantDomainFor, tenantBaseUrlFor };
