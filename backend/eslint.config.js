'use strict';

/**
 * ESLint — architectural rules only.
 *
 * This config is deliberately not a style config. It carries the rules that
 * enforce invariants the specs describe as absolute, where a review comment is
 * the only other control and reviews are fallible. Style, formatting, and the
 * usual `eslint:recommended` set are a separate decision; adding them here
 * would bury the two rules that actually gate a merge.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * SECURITY.md §2: "Scope at the data-access layer, not per query ... the
 * architecture, not developer discipline, is the control."
 *
 * `src/modules/tenancy` delivers that for every query that goes through it, but
 * nothing at runtime can stop a module writing `require('knex')` and issuing an
 * unscoped `SELECT` — the accessor is not in the call path to object to it.
 * CLAUDE.md calls raw table access "a review-blocking defect", and this is what
 * makes that claim enforceable rather than aspirational.
 *
 * ── WHY TWO RULES FOR ONE RESTRICTION ────────────────────────────────────
 *
 * `no-restricted-imports` only sees ESM `import` declarations. This backend is
 * `"type": "commonjs"` and every module uses `require()`, so that rule alone
 * would report nothing at all — a lint rule that silently passes is worse than
 * no rule, because it reads as coverage. `no-restricted-syntax` with an AST
 * selector is what actually catches `require('knex')` today;
 * `no-restricted-imports` is kept alongside it so the restriction still holds
 * if any part of this codebase later moves to ESM.
 */

/**
 * The three places allowed to construct a database connection.
 *
 *   src/db                  the application's single knex instance
 *   src/modules/tenancy     the scoped accessor, which wraps that instance
 *   tests/helpers           the suite's own connection and the schema rebuild
 *                           in global-setup — the isolation tests compare the
 *                           accessor's behaviour against raw queries, so they
 *                           need a path that bypasses it, on purpose
 *
 * `knexfile.js`, `migrations/`, and `seeds/` are absent from this list because
 * they do not import knex: knexfile exports plain configuration, and a
 * migration receives the knex instance as an argument.
 */
const CONNECTION_OWNERS = [
  'src/db/**/*.js',
  'src/modules/tenancy/**/*.js',
  'tests/helpers/**/*.js',
];

/** Matches `knex`, `mysql2`, and any subpath of either — but not `knexfile`. */
const DRIVER_PATTERN = String.raw`/^(knex|mysql2)(\/.*)?$/`;

const DRIVER_MESSAGE =
  'Import the scoped accessor from src/modules/tenancy instead of the database driver. ' +
  'Every tenant-owned table is reached through an accessor that injects tenant_id and ' +
  'property_id (SECURITY.md §2); a raw connection has no scope and cannot be given one. ' +
  'If this file legitimately owns a connection, add it to CONNECTION_OWNERS in eslint.config.js ' +
  'and say why in the review.';

const INTERNALS_MESSAGE =
  "Import from 'src/modules/tenancy' rather than reaching into the module's internals — " +
  'CLAUDE.md: cross-module calls go through the module surface, never direct file access.';

/**
 * Composed per file group below, because the two restrictions have different
 * exceptions: the test suite is allowed to reach into the tenancy module's
 * internals (`scoped-db.js` exports `scopeRequirements` and
 * `assertScopeSurvives` specifically so the isolation suite can assert the
 * rules directly rather than only through their effects), but is not allowed to
 * open its own database connection outside `tests/helpers`.
 */
const driverRestriction = {
  selector: `CallExpression[callee.name="require"][arguments.0.value=${DRIVER_PATTERN}]`,
  message: DRIVER_MESSAGE,
};

const internalsRestriction = {
  selector:
    'CallExpression[callee.name="require"]' +
    '[arguments.0.value=/tenancy\\/(scoped-db|context)$/]',
  message: INTERNALS_MESSAGE,
};

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
    },
    rules: {
      // Catches `require('knex')` — the form this codebase actually uses.
      'no-restricted-syntax': ['error', driverRestriction, internalsRestriction],

      // Catches `import knex from 'knex'` — inert today, correct tomorrow.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['knex', 'knex/*', 'mysql2', 'mysql2/*'], message: DRIVER_MESSAGE },
            { group: ['**/tenancy/scoped-db', '**/tenancy/context'], message: INTERNALS_MESSAGE },
          ],
        },
      ],
    },
  },

  {
    // The suite asserts the accessor's internals against its behaviour, so it
    // reads the files behind the module surface. It still may not construct a
    // connection — that stays with `tests/helpers` below.
    files: ['tests/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error', driverRestriction],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['knex', 'knex/*', 'mysql2', 'mysql2/*'], message: DRIVER_MESSAGE }] },
      ],
    },
  },

  {
    files: CONNECTION_OWNERS,
    rules: {
      // These files are the exception the rule exists to define. Both rules are
      // disabled together because this config gives them no other job.
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },
];
