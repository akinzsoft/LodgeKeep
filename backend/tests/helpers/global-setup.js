'use strict';

/**
 * Jest globalSetup — rebuild the test schema from migrations before the suite.
 *
 * TESTING.md Part 1 requires exactly two things of this file: that it rebuilds
 * the schema from the checked-in migrations, and that it **refuses to run
 * unless the database name contains "test"**. The second is the more important
 * one — this function drops every table it finds.
 *
 * Rebuilding from migrations rather than from a dumped schema is deliberate: it
 * means every test run exercises the migration path that production will take,
 * so a migration that cannot actually run is a failing suite rather than a
 * failed release (DATABASE.md — migrations are backwards-compatible and
 * reversible, and reversibility is a release gate).
 */

require('dotenv').config();

const knexFactory = require('knex');
const config = require('../../knexfile');

module.exports = async function globalSetup() {
  const database = config.test.connection.database;

  // The guard. knexfile.js checks this too; both exist because a mistyped
  // DB_NAME_TEST that reached this point would drop a real schema.
  if (!database || !database.toLowerCase().includes('test')) {
    throw new Error(
      `Refusing to rebuild "${database}": the test database name must contain ` +
        '"test". This function drops every table in the schema.'
    );
  }

  const knex = knexFactory(config.test);

  try {
    const rows = await knex('information_schema.tables')
      .select('table_name as name')
      .where({ table_schema: database, table_type: 'BASE TABLE' });

    if (rows.length) {
      // Foreign keys are RESTRICT throughout (ARCHITECTURE.md §3), so there is
      // no drop order that works — disable the checks for the teardown only.
      await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
      try {
        for (const { name } of rows) {
          await knex.raw('DROP TABLE IF EXISTS ??', [name]);
        }
      } finally {
        await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
      }
    }

    const [, applied] = await knex.migrate.latest();
    if (!applied.length) {
      throw new Error(
        'No migrations ran against the freshly dropped test schema — check ' +
          'knexfile.js migrations.directory.'
      );
    }
  } finally {
    await knex.destroy();
  }
};
