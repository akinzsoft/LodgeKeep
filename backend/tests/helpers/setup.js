'use strict';

/**
 * Jest setupFilesAfterEnv — per-test-file wiring.
 *
 * TESTING.md Part 1 describes this file as "app instance, auth token minting,
 * per-test transaction wrapper". Only the last of those exists yet, and it
 * lives in `./db.js` so a test file can import it explicitly rather than
 * relying on a global.
 *
 * The app instance and token minting arrive with the auth module (PLAN.md
 * Phase 0): once there is an Express app and a token signer, this file is where
 * `supertest(app)` and `mintStaffToken` / `mintGuestToken` / `mintPlatformToken`
 * belong — the HTTP-level ISO-1..ISO-8 and AUTH-1..AUTH-15 cases need all
 * three, and the three separate minting functions are what keep the audience
 * check (API.md §4) honest in tests.
 */

const { destroy } = require('./db');

// Schema work against a real MySQL instance is slower than the 5s default, and
// a timeout here reads as a mysterious failure rather than a slow query.
jest.setTimeout(30000);

afterAll(async () => {
  await destroy();
});
