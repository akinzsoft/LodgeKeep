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
  impersonationContext,
  systemContext,
  workerContext,
  withActiveProperty,
  withTenantLifecycle,
} = require('./context');
const { resolvePropertyBySlug } = require('./property-resolution');
const { SYSTEM_ROLES, ALL_PERMISSION_KEYS, DEFAULT_ROLE_PERMISSIONS } = require('./default-rbac');

module.exports = {
  createScopedDb,
  AUDIENCES,
  contextFromSession,
  guestContextFromSession,
  platformContext,
  impersonationContext,
  systemContext,
  workerContext,
  withActiveProperty,
  withTenantLifecycle,
  resolvePropertyBySlug,
  SYSTEM_ROLES,
  ALL_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
};
