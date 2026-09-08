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
 * Gap closure (user-reported, live-tested): "the mail goin to my spam."
 * An HTML-only message with no plain-text alternative is one of the most
 * common, well-documented spam-classifier signals (every legitimate bulk-
 * mail sender includes both parts) — every template this codebase ships is
 * only ever authored as `body_html`, so this derives a reasonable plain-text
 * fallback from it rather than requiring a second, hand-maintained template
 * field per event. A generic tag-stripper is genuinely sufficient here: this
 * codebase's own templates (`DEFAULT_TEMPLATES`) are simple `<p>`/`<a>`
 * markup, never a full HTML document.
 */
function htmlToText(html) {
  return html
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
    const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!fromAddress) {
      throw new Error('EMAIL_PROVIDER=smtp requires SMTP_FROM (or SMTP_USER as a fallback) — see .env.example.');
    }
    // A bare mailbox address with no display name (nodemailer's default
    // absent one) is a second common spam-classifier signal alongside a
    // missing text part — SMTP_FROM_NAME lets a mailbox whose own local
    // part reads oddly for transactional mail (e.g. a hosting-renewal
    // inbox reused for this purpose) still present as a real sender name.
    const fromName = process.env.SMTP_FROM_NAME || 'LodgeKeep';
    const info = await transport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to,
      subject,
      html,
      text: htmlToText(html),
    });
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

module.exports = { getEmailAdapter, consoleAdapter, smtpAdapter, htmlToText, __closeSmtpTransportForTesting };
