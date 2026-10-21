'use strict';

/**
 * Abuse limits for email sent through the PLATFORM mailbox (a tenant on its own
 * SMTP is never limited by us). Counters live in Redis, per tenant.
 *
 * Two classes, so a flood of one kind can never stop the other:
 * - `capped`: reservation emails and AR invoices (the bulk, guest-facing
 *   mail). Limited by a per-tenant daily cap and a per-tenant per-minute rate.
 * - `critical`: everything else, above all the sign-in emails (staff
 *   invitations, password resets, the staff MFA code). EXEMPT from the daily cap,
 *   so booking mail can never lock staff out. They keep their own per-tenant
 *   per-minute rate and a per-recipient rate (stops mailbombing one person).
 *
 * Defaults are safe and every number can be changed by env. A Redis outage
 * fails OPEN (logged): an abuse limit must not become an outage of its own.
 */

const crypto = require('crypto');
const { AppError } = require('./errors');
const { rateLimitRedisConnection } = require('./rate-limit-redis-connection');

/** Events that count against the daily cap: bulk reservation mail and AR invoices. */
const CAPPED_EVENT_TYPES = new Set([
  'reservation.confirmed',
  'reservation.cancelled',
  'guest.checked_in',
  'guest.checked_out',
  'ar.invoice_generated',
  'ar.payment_received',
  'tenant.trial_started',
  'tenant.subscribed',
  'tenant.payment_recorded',
  'tenant.domain_moved',
]);

function classifyEvent(eventType) {
  return CAPPED_EVENT_TYPES.has(eventType) ? 'capped' : 'critical';
}

function intFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function limits() {
  return {
    dailyCap: intFromEnv('PLATFORM_EMAIL_DAILY_CAP', 500),
    cappedPerMinute: intFromEnv('PLATFORM_EMAIL_RATE_PER_MIN', 30),
    criticalPerMinute: intFromEnv('PLATFORM_EMAIL_AUTH_RATE_PER_MIN', 60),
    recipientPerWindow: intFromEnv('PLATFORM_EMAIL_RECIPIENT_LIMIT', 10),
    recipientWindowMinutes: intFromEnv('PLATFORM_EMAIL_RECIPIENT_WINDOW_MIN', 15),
  };
}

class EmailLimitError extends AppError {
  constructor(kind, message) {
    super('RATE_LIMITED_EMAIL', message, 429);
    this.kind = kind;
  }
}

function dayKey(tenantId, now) {
  return `emailq:day:${tenantId}:${now.toISOString().slice(0, 10)}`;
}

/** Increments a counter with a TTL; returns the new value. */
async function bump(redis, key, ttlSeconds) {
  const value = await redis.incr(key);
  if (value === 1) await redis.expire(key, ttlSeconds);
  return value;
}

/**
 * Counts one platform-mailbox send against the tenant's limits, or throws
 * `EmailLimitError`. Call immediately before sending.
 */
async function reservePlatformSend({ tenantId, recipient, eventClass, now = new Date() }) {
  const cfg = limits();
  let redis;
  try {
    redis = rateLimitRedisConnection();
    const minute = Math.floor(now.getTime() / 60000);

    if (eventClass === 'capped') {
      const perMinute = await bump(redis, `emailq:min:capped:${tenantId}:${minute}`, 120);
      if (perMinute > cfg.cappedPerMinute) {
        throw new EmailLimitError('rate', `Too many emails sent too quickly (limit ${cfg.cappedPerMinute} per minute). It will be retried shortly.`);
      }
      const day = await bump(redis, dayKey(tenantId, now), 60 * 60 * 48);
      if (day > cfg.dailyCap) {
        await redis.decr(dayKey(tenantId, now));
        throw new EmailLimitError('daily_cap', `Daily email limit reached (${cfg.dailyCap} per day on the platform mailbox). Use your own SMTP in Setup → Email to send more, or resend tomorrow.`);
      }
      return;
    }

    const perMinute = await bump(redis, `emailq:min:critical:${tenantId}:${minute}`, 120);
    if (perMinute > cfg.criticalPerMinute) {
      throw new EmailLimitError('rate', `Too many emails sent too quickly (limit ${cfg.criticalPerMinute} per minute). It will be retried shortly.`);
    }
    const window = Math.floor(now.getTime() / (cfg.recipientWindowMinutes * 60000));
    const who = crypto.createHash('sha256').update(String(recipient).toLowerCase()).digest('hex').slice(0, 24);
    const perRecipient = await bump(redis, `emailq:rcpt:${tenantId}:${who}:${window}`, cfg.recipientWindowMinutes * 120);
    if (perRecipient > cfg.recipientPerWindow) {
      throw new EmailLimitError('recipient', `Too many emails to this address in a short time (limit ${cfg.recipientPerWindow} per ${cfg.recipientWindowMinutes} minutes).`);
    }
  } catch (error) {
    if (error instanceof EmailLimitError) throw error;
    console.error('[email-quota] Redis unavailable; the platform email limit was not applied:', error?.message);
  }
}

/** How many capped emails the tenant has sent today, and the cap — shown in Setup → Email. */
async function platformUsageToday({ tenantId, now = new Date() }) {
  const { dailyCap } = limits();
  try {
    const raw = await rateLimitRedisConnection().get(dayKey(tenantId, now));
    return { sentToday: Number(raw ?? 0), dailyCap };
  } catch {
    return { sentToday: null, dailyCap };
  }
}

/**
 * Resending one invitation: at most one per minute and a small daily cap, so the
 * button cannot be used to spam an address. Returns null when allowed, else a
 * message. Env: INVITATION_RESEND_MIN_INTERVAL_SECONDS (60), INVITATION_RESEND_DAILY_CAP (5).
 * Fails open if Redis is down (logged).
 */
async function reserveInvitationResend({ tenantId, invitationId, now = new Date() }) {
  const interval = Number(process.env.INVITATION_RESEND_MIN_INTERVAL_SECONDS ?? 60);
  const dailyCap = intFromEnv('INVITATION_RESEND_DAILY_CAP', 5);
  try {
    const redis = rateLimitRedisConnection();
    if (interval > 0) {
      const first = await redis.set(`invresend:min:${tenantId}:${invitationId}`, '1', 'EX', interval, 'NX');
      if (first === null) return `This invitation was resent a moment ago. Wait about ${interval >= 60 ? 'a minute' : `${interval} seconds`} before resending it again.`;
    }
    const key = `invresend:day:${tenantId}:${invitationId}:${now.toISOString().slice(0, 10)}`;
    const count = await bump(redis, key, 60 * 60 * 48);
    if (count > dailyCap) {
      await redis.decr(key);
      return `This invitation has been resent the maximum number of times today (${dailyCap}). Try again tomorrow, or delete it and invite the person again.`;
    }
    return null;
  } catch (error) {
    console.error('[invitation-resend] Redis unavailable; the resend limit was not applied:', error?.message);
    return null;
  }
}

module.exports = {
  reserveInvitationResend, CAPPED_EVENT_TYPES, classifyEvent, reservePlatformSend, platformUsageToday, EmailLimitError, limits };
