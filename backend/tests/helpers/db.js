'use strict';

/**
 * The test suite's database connection.
 *
 * One knex instance for the whole run (the suite is `--runInBand`, so there is
 * one worker), created lazily and destroyed by `setup.js`'s afterAll hook.
 *
 * The name guard is repeated here on purpose. `knexfile.js` refuses to build a
 * test config whose database name lacks "test", and `global-setup.js` refuses
 * to rebuild such a schema; this third check means no test file can reach a
 * development database even if it constructs its own connection.
 */

const knexFactory = require('knex');
const config = require('../../knexfile');

let instance = null;

function assertTestDatabase(name) {
  if (!name || !name.toLowerCase().includes('test')) {
    throw new Error(
      `Refusing to run tests against "${name}": the database name must contain ` +
        '"test". The suite truncates and rebuilds this schema.'
    );
  }
  return name;
}

/** The shared knex instance for the test schema. */
function db() {
  if (!instance) {
    assertTestDatabase(config.test.connection.database);
    instance = knexFactory(config.test);
  }
  return instance;
}

async function destroy() {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
}

/**
 * Per-file transaction wrapper (TESTING.md Part 2, ground rules: "each test file
 * runs in a transaction rolled back afterwards, so tests don't leak state").
 *
 * Call at the top of a describe block; every test in the file then reads
 * `ref.trx`. Rolling back rather than deleting keeps the fixtures identical for
 * the next file no matter how a test failed partway through.
 *
 * Statement-level failures are safe inside this wrapper: InnoDB rolls back the
 * failed *statement* on a duplicate-key or foreign-key error, not the whole
 * transaction, which is exactly what lets one file assert many rejections in a
 * row and still roll back cleanly at the end.
 */
function useRolledBackTransaction() {
  const ref = { trx: null };

  beforeAll(async () => {
    ref.trx = await db().transaction();
  });

  afterAll(async () => {
    if (ref.trx && !ref.trx.isCompleted()) await ref.trx.rollback();
    ref.trx = null;
  });

  return ref;
}

module.exports = { db, destroy, useRolledBackTransaction, assertTestDatabase };
