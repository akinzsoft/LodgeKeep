'use strict';

/**
 * Shared guard for scripts that must only ever touch a local development
 * database. Returns the list of reasons the environment looks wrong (empty =
 * safe); `assertDevelopmentOnly` throws if there are any.
 *
 * Deliberately strict: the database must be named exactly `lodgekeep_dev` on a
 * local host, and anything that looks like a deployed environment (production
 * NODE_ENV, a real app domain, a Docker-network DB host) refuses the run.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function developmentOnlyProblems(env = process.env) {
  const problems = [];
  if (env.NODE_ENV === 'production') problems.push('NODE_ENV is production');
  if (!/^lodgekeep_dev(_[a-z0-9]+)?$/.test(env.DB_NAME ?? '')) problems.push(`DB_NAME must be lodgekeep_dev or lodgekeep_dev_<suffix> (got ${env.DB_NAME ?? 'unset'})`);
  if (!LOCAL_HOSTS.has(env.DB_HOST)) problems.push(`DB_HOST must be local (got ${env.DB_HOST ?? 'unset'})`);
  for (const name of ['APP_DOMAIN', 'PRIMARY_APP_DOMAIN']) {
    const value = (env[name] ?? '').trim().toLowerCase();
    if (value && value !== 'localhost' && !value.endsWith('.localhost')) problems.push(`${name} is set to a real domain (${value})`);
  }
  if (env.EMAIL_PROVIDER && env.EMAIL_PROVIDER !== 'console') problems.push('EMAIL_PROVIDER would send real email');
  if (env.PAYSTACK_SECRET_KEY && /^sk_live_/.test(env.PAYSTACK_SECRET_KEY)) problems.push('a live Paystack key is configured');
  return problems;
}

function assertDevelopmentOnly(env = process.env) {
  const problems = developmentOnlyProblems(env);
  if (problems.length) throw new Error(`Refusing to run: this looks like a non-development environment. ${problems.join('; ')}.`);
}

module.exports = { developmentOnlyProblems, assertDevelopmentOnly };
