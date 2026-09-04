'use strict';

/**
 * The application's single database connection — ARCHITECTURE.md §2 lists
 * `/backend/src/db` alongside `/backend/src/modules/tenancy` as the only two
 * places allowed to construct one (see `eslint.config.js`'s `CONNECTION_OWNERS`).
 *
 * Every module reaches the database through `scopedDb.for(context)`
 * (`src/modules/tenancy`), never through this file directly. This module exists
 * only to build the one knex instance the process runs on and hand out the
 * accessor wrapping it — `require('../db')` gives a module the accessor, not
 * the connection.
 */

const knexFactory = require('knex');
const knexfile = require('../../knexfile');
const { createScopedDb } = require('../modules/tenancy');

/**
 * `test` when the test suite's own connection isn't in play — Jest sets
 * `NODE_ENV=test` by default, and this module is never imported by
 * `tests/helpers/db.js`, which owns its own connection so the app and the test
 * suite never share a knex instance even when both run in the same process.
 */
function configFor(env) {
  const config = knexfile[env];
  if (!config) {
    throw new Error(
      `No knexfile config for NODE_ENV="${env}". Add one to knexfile.js before running the app in this environment.`
    );
  }
  return config;
}

let knexInstance = null;
let scopedDbInstance = null;

/** The shared knex instance for the running process. Built once, lazily. */
function knex() {
  if (!knexInstance) {
    knexInstance = knexFactory(configFor(process.env.NODE_ENV || 'development'));
  }
  return knexInstance;
}

/** The scoped accessor bound to the process's knex instance. */
function scopedDb() {
  if (!scopedDbInstance) {
    scopedDbInstance = createScopedDb(knex());
  }
  return scopedDbInstance;
}

async function destroy() {
  if (knexInstance) {
    await knexInstance.destroy();
    knexInstance = null;
    scopedDbInstance = null;
  }
}

/**
 * Test-only seam. Points every future `scopedDb()` call at an
 * already-open connection — in practice, `tests/helpers/db.js`'s per-test-file
 * transaction — instead of building this module's own pool.
 *
 * Why this needs to exist at all: `tests/helpers/db.js` seeds fixtures inside
 * one transaction that the test file rolls back at the end (TESTING.md Part 1,
 * "each test file runs in a transaction rolled back afterwards"). Uncommitted
 * work in that transaction is invisible to any query issued from a different
 * connection — which is what every HTTP request through `src/app.js` would be,
 * since it reaches the database via this module's own separate pool. Without
 * this seam, an HTTP-level auth test could never see its own fixtures.
 *
 * Never called from application code — only from `tests/helpers/app.js`.
 */
function __setConnectionForTesting(connection) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setConnectionForTesting must never run outside tests.');
  }
  knexInstance = connection;
  scopedDbInstance = createScopedDb(connection);
}

function __resetForTesting() {
  knexInstance = null;
  scopedDbInstance = null;
}

module.exports = { knex, scopedDb, destroy, __setConnectionForTesting, __resetForTesting };
