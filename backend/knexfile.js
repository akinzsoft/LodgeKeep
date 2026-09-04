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

  test: {
    ...shared,
    connection: connection(testDatabaseName()),
    // The suite runs with --runInBand and needs real connection-level
    // contention for the concurrency tests (TESTING.md Part 1), so the pool
    // stays small but must allow more than one connection — a single-connection
    // pool would serialise the last-room race and make it pass vacuously.
    pool: { min: 1, max: 5 },
  },
};
