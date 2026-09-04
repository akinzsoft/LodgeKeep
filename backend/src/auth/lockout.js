'use strict';

/**
 * Account lockout — TESTING.md AUTH-3, AUTH-4; SECURITY.md §1.1
 * ("rate limiting and progressive lockout ... per account and per IP").
 *
 * Counted from `auth_events` rather than Redis. See the block comment at the
 * top of `20260904101500_create_auth_events.js` for the full reasoning: this
 * is the 423 LOCKED_ACCOUNT security control, kept durable in MySQL, distinct
 * from the 429 RATE_LIMITED traffic-shaping tier that ARCHITECTURE.md §15
 * puts in Redis and which is not wired up in this pass.
 *
 * Two dimensions, deliberately different shapes (AUTH-4's whole point): a
 * shared front-desk terminal produces many failures across many accounts from
 * one IP, and that must not lock everyone out, so the per-IP ceiling is loose
 * and the per-account ceiling is tight.
 */

const { scopedDb } = require('../db');
const { systemContext } = require('../modules/tenancy');

const ACCOUNT_THRESHOLD = 5;
const ACCOUNT_WINDOW_MINUTES = 15;

const IP_THRESHOLD = 20;
const IP_WINDOW_MINUTES = 15;

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function recentFailureCount({ column, value, windowMinutes }) {
  const db = scopedDb().for(systemContext());
  return db
    .platform()
    .table('auth_events')
    .where(column, value)
    .where('event_type', 'login_failure')
    .where('occurred_at', '>=', minutesAgo(windowMinutes))
    .count();
}

/**
 * Checks both dimensions for a staff login attempt and returns which one (if
 * any) is tripped. `userId` is null when the email did not resolve to an
 * account — only the per-IP dimension applies then, which is exactly the case
 * that dimension exists for.
 */
async function checkStaffLockout({ userId, ip }) {
  if (userId) {
    const accountFailures = await recentFailureCount({
      column: 'user_id',
      value: userId,
      windowMinutes: ACCOUNT_WINDOW_MINUTES,
    });
    if (accountFailures >= ACCOUNT_THRESHOLD) return 'account';
  }

  if (ip) {
    const ipFailures = await recentFailureCount({
      column: 'ip',
      value: ip,
      windowMinutes: IP_WINDOW_MINUTES,
    });
    if (ipFailures >= IP_THRESHOLD) return 'ip';
  }

  return null;
}

module.exports = {
  checkStaffLockout,
  ACCOUNT_THRESHOLD,
  ACCOUNT_WINDOW_MINUTES,
  IP_THRESHOLD,
  IP_WINDOW_MINUTES,
};
