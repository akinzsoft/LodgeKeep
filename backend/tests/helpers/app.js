'use strict';

/**
 * The Express app instance for HTTP-level tests — TESTING.md Part 1's
 * "app instance, auth token minting, per-test transaction wrapper", the two
 * pieces `setup.js` said would arrive with the auth module.
 *
 * Wires the app's database access to the SAME transaction `useRolledBackTransaction`
 * uses for fixtures — see `src/db/index.js`'s `__setConnectionForTesting` for
 * why that is necessary rather than incidental.
 */

const request = require('supertest');
const { useRolledBackTransaction } = require('./db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');

/**
 * Call at the top of a describe block, alongside (or in place of) a bare
 * `useRolledBackTransaction()`. Returns `{ trx, app, request }`:
 *   trx      the shared transaction — seed fixtures on it, as any other file does
 *   app      the Express app, built after the connection override is in place
 *   request  `supertest(app)` bound to that instance, for readability at call sites
 */
function useTestApp() {
  const tx = useRolledBackTransaction();
  const ref = { app: null, request: null };

  beforeAll(() => {
    dbModule.__setConnectionForTesting(tx.trx);
    ref.app = createApp();
    ref.request = request(ref.app);
  });

  afterAll(() => {
    dbModule.__resetForTesting();
  });

  return {
    get trx() {
      return tx.trx;
    },
    get app() {
      return ref.app;
    },
    get request() {
      return ref.request;
    },
  };
}

module.exports = { useTestApp };
