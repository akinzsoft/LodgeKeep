'use strict';

require('dotenv').config();

/**
 * Knex configuration — Lodgekeep backend.
 *
 * Migrations live here and are checked into the repo; they run against every
 * tenant at once, so they must be backwards-compatible and reversible
 * (ARCHITECTURE.md §1, DATABASE.md).
 */

/** Required env var, with no silent fallback for anything that selects a database. */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`
    );
  }
  return value;
}

/**
 * Connection options shared by every environment.
 *
 * `decimalNumbers: false` and `dateStrings` are correctness settings, not
 * preferences:
 *
 *  - Money is exact DECIMAL end to end (ARCHITECTURE.md §1, §12). mysql2 must
 *    hand DECIMAL columns back as strings; letting it coerce them to JS numbers
 *    reintroduces the float drift the schema exists to prevent.
 *  - `properties.current_business_date` and every stored `business_date` are
 *    DATE columns carrying the property's accounting date, which is not the
 *    server's wall clock (ARCHITECTURE.md §6). Parsing them into JS Date
 *    objects applies the process timezone and can shift the day by one, which
 *    is exactly the class of bug the business-date design exists to avoid.
 *    Keep them as 'YYYY-MM-DD' strings.
 */
function connection(database) {
  return {
    // No fallback for host or port. The compose stack maps MySQL to a
    // non-default host port (3310) to avoid colliding with other local MySQL
    // instances, and a silent default of 3306 would quietly point migrations
    // at a different server — see .env.example.
    host: required('DB_HOST'),
    port: Number(required('DB_PORT')),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database,
    charset: 'utf8mb4',
    timezone: 'Z',
    decimalNumbers: false,
    dateStrings: ['DATE'],
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
}

const shared = {
  client: 'mysql2',
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: './seeds',
  },
};

/**
 * The test database name must contain "test".
 *
 * TESTING.md's `tests/helpers/global-setup.js` refuses to run unless this holds,
 * because the suite drops and rebuilds the schema from migrations on every run.
 * Enforcing it here as well means a mistyped DB_NAME_TEST fails when the
 * connection is configured, rather than after something has already been
 * dropped.
 */
function testDatabaseName() {
  const name = required('DB_NAME_TEST');
  if (!name.toLowerCase().includes('test')) {
    throw new Error(
      `Refusing to use "${name}" as the test database: the name must contain ` +
        '"test". The test suite rebuilds this schema from migrations on every ' +
        'run, and this guard is what stops that happening to a development or ' +
        'production database.'
    );
  }
  return name;
}

module.exports = {
  development: {
    ...shared,
    connection: connection(required('DB_NAME')),
    pool: { min: 2, max: 10 },
  },

  /**
   * Production Docker deployment (docker-compose.prod.yml). This key did
   * not exist before — `src/db/index.js`'s `configFor(env)` throws
   * `No knexfile config for NODE_ENV="production"` on the very first
   * database call without it, and `NODE_ENV=production` is load-bearing
   * for real security behaviour elsewhere (the refresh-token cookie's
   * `Secure` flag, disabling the dev-only MFA bypass code and
   * `dev_only_code` login disclosure, disabling tenant-resolution's dev
   * `X-Tenant-Slug` override) — so this can't be routed around by simply
   * deploying with a different NODE_ENV value.
   *
   * Identical shape to `development`: the same env-var-driven
   * `connection()` helper, just a differently-valued `DB_NAME` supplied at
   * deploy time. Pool size unchanged from dev — this backend runs its HTTP
   * server AND all 9 BullMQ workers in one process sharing one pool (no
   * separate worker deploy), and the production compose file's own
   * `--max-connections=150` on MySQL comfortably covers this pool plus the
   * one-shot `migrate` service's own transient connection.
   */
  production: {
    ...shared,
    connection: connection(required('DB_NAME')),
    pool: { min: 2, max: 10 },
  },

  /**
   * A getter, not a plain value — deliberately. This whole object is a
   * literal, so every OTHER key's value is evaluated eagerly the moment
   * this module is `require()`d, regardless of which key `NODE_ENV`
   * actually selects. Before this pass, that coupling was invisible: dev's
   * own `.env.example` always documents `DB_NAME_TEST` alongside `DB_NAME`,
   * so a normal dev environment already satisfies both. It stopped being
   * invisible the moment a real `production` key existed — a production
   * deployment has no legitimate reason to ever know a test-database name,
   * and `required('DB_NAME_TEST')` was throwing on the very first
   * `require('./knexfile.js')` (confirmed directly) purely because THIS
   * property, never actually used in production, still got evaluated
   * alongside it. A getter defers `testDatabaseName()`'s own `required()`
   * check until something actually reads `.test` — which only ever happens
   * when `NODE_ENV=test` selects this key — so a production or development
   * process that never touches `.test` no longer needs `DB_NAME_TEST` set
   * at all.
   */
  get test() {
    return {
      ...shared,
      connection: connection(testDatabaseName()),
      // The suite runs with --runInBand and needs real connection-level
      // contention for the concurrency tests (TESTING.md Part 1), so the pool
      // stays small but must allow more than one connection — a single-connection
      // pool would serialise the last-room race and make it pass vacuously.
      pool: { min: 1, max: 5 },
    };
  },
};
