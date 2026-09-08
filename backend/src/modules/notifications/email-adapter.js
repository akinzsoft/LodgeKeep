'use strict';

/**
 * The email provider adapter — PRODUCT_REQUIREMENTS.md §3.21: "a
 * transactional email service with delivery webhooks (not raw SMTP from the
 * app server...)." This session's confirmed decision: build the real outbox
 * pattern, delivery log, and retry/backoff end to end, but the actual
 * "send" call is a pluggable interface with a `console` adapter active by
 * default — no provider credentials exist in this environment — mirroring
 * how the password-reset endpoints already return their token directly in
 * non-production rather than emailing it (`src/auth`'s own header). Swapping
 * in a real provider (SendGrid/Postmark/SES) later is a new adapter file
 * plus one env var, no change anywhere else in this module.
 *
 * Every adapter returns `{ providerRef, status }` — `status` is always
 * 'sent' from the ADAPTER's point of view (it accepted the send); 'delivered'
 * /'bounced' arrive later via the provider's own webhook (not built this
 * pass — no real provider is wired to send one), which is why
 * `notification_log.status` is a separate, later-updatable column rather
 * than fixed at send time.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

/**
 * Logs the send instead of transmitting it — visible in server output for
 * local/dev verification, the same spirit as the password-reset dev
 * response.
 */
const consoleAdapter = {
  name: 'console',
  async send({ to, subject, html }) {
    const providerRef = `console-${crypto.randomUUID()}`;
    console.log(`[email:console] to=${to} subject="${subject}" ref=${providerRef}\n${html}`);
    return { providerRef, status: 'sent' };
  },
};

/**
 * A real transactional-email transport over plain SMTP — the user's own
 * webhosting mailbox, not a dedicated transactional provider (SendGrid/SES/
 * etc. remain unbuilt; adding one later is a new adapter file plus one env
 * var, per this file's own header). Lazily constructed and memoized (one
 * pooled connection for the process's lifetime), same shape as `redisConnection()`/
 * `knex()`'s own lazy singletons — nothing here opens a connection until the
 * first real send.
 */
let smtpTransport = null;

function buildSmtpTransport() {
  if (!smtpTransport) {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    if (!host) {
      throw new Error('EMAIL_PROVIDER=smtp requires SMTP_HOST (see .env.example).');
    }
    smtpTransport = nodemailer.createTransport({
      host,
      port,
      // Port 465 is implicit TLS; every other port (587, 25) negotiates TLS
      // via STARTTLS instead — nodemailer's own documented convention,
      // matching how most webhosting SMTP providers explain their own ports.
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
  }
  return smtpTransport;
}

const smtpAdapter = {
  name: 'smtp',
  async send({ to, subject, html }) {
    // Host validated first — "which server" is more fundamental than "who
    // it's from", and building the transport is what actually needs it.
    const transport = buildSmtpTransport();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!from) {
      throw new Error('EMAIL_PROVIDER=smtp requires SMTP_FROM (or SMTP_USER as a fallback) — see .env.example.');
    }
    const info = await transport.sendMail({ from, to, subject, html });
    return { providerRef: info.messageId, status: 'sent' };
  },
};

const ADAPTERS = { console: consoleAdapter, smtp: smtpAdapter };

/** `EMAIL_PROVIDER` env var selects the adapter; defaults to `console` (no credentials required). */
function getEmailAdapter() {
  const name = process.env.EMAIL_PROVIDER || 'console';
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unknown EMAIL_PROVIDER "${name}" — no adapter registered in src/modules/notifications/email-adapter.js.`);
  }
  return adapter;
}

/** Test-only teardown, mirroring `__closeQueuesForTesting`/`destroyRedisConnection` — closes the pooled SMTP connection so a test process can exit cleanly. */
function __closeSmtpTransportForTesting() {
  if (smtpTransport) {
    smtpTransport.close();
    smtpTransport = null;
  }
}

module.exports = { getEmailAdapter, consoleAdapter, smtpAdapter, __closeSmtpTransportForTesting };
