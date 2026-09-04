'use strict';

/**
 * Jest configuration — see TESTING.md Part 1.
 *
 * The suite runs against a real MySQL test schema, not mocks: the behaviours
 * most worth testing here (unique constraints, foreign keys, transaction
 * rollback, row locking on the last-room race) are database behaviours, and
 * mocking the database tests the mock.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],

  // The suite shares one schema and the concurrency tests need real
  // connection-level contention rather than worker noise. Also enforced by the
  // `test` script; set here so a bare `npx jest` behaves the same way.
  maxWorkers: 1,

  // global-setup rebuilds the schema from migrations before the suite and
  // refuses to run unless the DB name contains "test" (TESTING.md Part 1).
  // setup.js carries the per-test transaction wrapper; the app instance and
  // token minting join it with the auth module (PLAN.md Phase 0).
  globalSetup: '<rootDir>/tests/helpers/global-setup.js',
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/setup.js'],

  // Coverage is by risk, not a blanket percentage (TESTING.md Part 1).
  // Money, night audit, availability, isolation, and auth need every branch
  // including failure paths; thresholds for those paths are added as each
  // module lands.
  collectCoverageFrom: ['src/**/*.js', '!src/**/index.js'],
};
