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

// Pinned BEFORE `./db` below (which transitively requires `knexfile.js`,
// which calls `dotenv.config()`) — dotenv never overrides an already-set
// var, so this wins regardless of what a developer has configured in their
// own local, gitignored `.env` for real dev-time email sending
// (`EMAIL_PROVIDER=smtp` plus real SMTP_* credentials). Without this, the
// suite's behavior — and whether `isEmailDeliveryReal()`-gated code paths
// like the MFA dev-only-code disclosure exercise their "console" branch —
// would silently depend on one developer's own machine, and a real SMTP
// send could even be attempted from inside the test run. `NODE_ENV` needs
// no equivalent pin: Jest itself already sets it to `'test'` before any
// module (including this one) ever runs.
process.env.EMAIL_PROVIDER = 'console';

const { destroy } = require('./db');
const { __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

// Schema work against a real MySQL instance is slower than the 5s default, and
// a timeout here reads as a mysterious failure rather than a slow query.
jest.setTimeout(30000);

afterAll(async () => {
  await destroy();
  // PLAN.md Phase 3: the reservations controller's reactive outbox-dispatch
  // trigger (`enqueueOutboxDispatch`) opens a real BullMQ Queue/Redis
  // connection the moment any reservation-mutation test runs. Neither
  // closes itself, so without this Jest hangs waiting for the event loop to
  // drain instead of exiting — the same "close every real connection you
  // open" discipline `destroy()` above already exists for MySQL.
  await __closeQueuesForTesting();
  await destroyRedisConnection();
});
