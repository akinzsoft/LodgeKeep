'use strict';

/**
 * The tenancy module's public surface — ARCHITECTURE.md §2 lists this module as
 * the home of "tenant records, plan entitlements, scoped data-access layer".
 *
 * Modules import from here, never from the files behind it: CLAUDE.md requires
 * cross-module calls to go through service functions rather than reaching into
 * another module's internals, and the accessor is the one piece of shared
 * infrastructure every other module will touch.
 */

const { createScopedDb } = require('./scoped-db');
const {
  AUDIENCES,
  contextFromSession,
  guestContextFromSession,
  platformContext,
  systemContext,
  workerContext,
  withActiveProperty,
} = require('./context');

module.exports = {
  createScopedDb,
  AUDIENCES,
  contextFromSession,
  guestContextFromSession,
  platformContext,
  systemContext,
  workerContext,
  withActiveProperty,
};
