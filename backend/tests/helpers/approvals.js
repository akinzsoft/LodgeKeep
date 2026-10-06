'use strict';

/**
 * Manager approvals in tests (src/modules/approvals): a gated action (a
 * settlement void, a POS refund, a stock override, a supermarket void or
 * oversell) needs a single-use token a manager issued with their PIN. These
 * helpers give the manager a real bcrypt-hashed PIN and fetch a token through
 * the real `POST /approvals` endpoint, the same way a till does.
 */

const { hashPassword } = require('../../src/auth/password');
const { flushRateLimitPrefixes } = require('./rate-limit');

const TEST_APPROVAL_PIN = '482915';
let hashPromise = null;

function testPinHash() {
  hashPromise ??= hashPassword(TEST_APPROVAL_PIN);
  return hashPromise;
}

/** Gives `userId` the test approval PIN (raw knex or a transaction). */
async function setApprovalPin(db, { tenantId, userId, pin = null }) {
  const pinHash = pin ? await hashPassword(pin) : await testPinHash();
  const existing = await db('approval_pins').where({ tenant_id: tenantId, user_id: userId }).first('id');
  if (existing) {
    await db('approval_pins').where({ id: existing.id }).update({ pin_hash: pinHash, failed_count: 0, failure_window_started_at: null, locked_until: null });
  } else {
    await db('approval_pins').insert({ tenant_id: tenantId, user_id: userId, pin_hash: pinHash, set_at: new Date() });
  }
}

/**
 * Asks for an approval as the person at the till (`token`), approved by
 * `approverUserId` with the test PIN. Returns the approval token.
 */
async function managerApproval(request, { token, approverUserId, action, targetId = null, reason = 'Test approval', pin = TEST_APPROVAL_PIN }) {
  // A file may ask for far more approvals than the real per-manager limit allows; the limiter has its own tests.
  await flushRateLimitPrefixes(['approvals-request:']);
  const res = await request
    .post('/api/v1/approvals')
    .set('Authorization', `Bearer ${token}`)
    .send({ action, approver_user_id: String(approverUserId), pin, reason, target_id: targetId === null ? undefined : String(targetId) });
  if (res.status !== 201) {
    throw new Error(`managerApproval(${action}) failed: ${res.status} ${JSON.stringify(res.body?.error)}`);
  }
  return res.body.data.token;
}

/**
 * `approvedPost(userId, url, body, action, targetId?)` for a test file: asks
 * `approver()` for an approval as `userId`, then posts with it in the
 * `X-Manager-Approval` header. `post(userId, url)` is the file's own request
 * builder (its auth and Idempotency-Key); `request()` returns supertest.
 */
function approvedPoster({ request, tokenFor, post, approver }) {
  return async (userId, url, body, action, targetId = null) => {
    const approval = await managerApproval(request(), { token: tokenFor(userId), approverUserId: approver(), action, targetId });
    return post(userId, url).set('X-Manager-Approval', approval).send(body);
  };
}

module.exports = { TEST_APPROVAL_PIN, testPinHash, setApprovalPin, managerApproval, approvedPoster };
