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
const { decrypt } = require('../../shared/encryption');
const { AppError } = require('../../shared/errors');
const {
  resolveSafeSmtpHost,
  assertAllowedPort,
  sanitizeDisplayName,
  isSingleEmailAddress,
  scrubSecrets,
  SMTP_SECURITY_MODES,
} = require('../../shared/smtp-guard');

/**
 * Gap closure (user-reported, live-tested): "the mail goin to my spam."
 * An HTML-only message with no plain-text alternative is one of the most
 * common, well-documented spam-classifier signals (every legitimate bulk-
 * mail sender includes both parts) — every template this codebase ships is
 * only ever authored as `body_html`, so this derives a reasonable plain-text
 * fallback from it rather than requiring a second, hand-maintained template
 * field per event. A generic tag-stripper is genuinely sufficient here: this
 * codebase's own templates are simple `<p>`/`<a>`/table markup inside the
 * branded shell (`email-layout.js`); the document head, the hidden inbox
 * preheader, and images are dropped, and table rows become lines.
 */
function htmlToText(html) {
  return html
    .replace(/<(head|style|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*display:none[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|h2|div|tr)>/gi, '\n\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
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
  async send({ to, subject, html, attachments }) {
    const providerRef = `console-${crypto.randomUUID()}`;
    const attached = attachments?.length ? ` attachments=${attachments.map((a) => a.filename).join(',')}` : '';
    console.log(`[email:console] to=${to} subject="${subject}" ref=${providerRef}${attached}\n${html}`);
    return { providerRef, status: 'sent' };
  },
};

/**
 * Email modes (Setup → Email), stored in `email_settings.provider`:
 * - `platform` (the default): the platform's own SMTP mailbox from the server env.
 *   Tenants never see or receive those credentials. The From address is ALWAYS
 *   the platform's verified sender; the property name is only the display name
 *   and the property's contact address is the Reply-To.
 * - `smtp` = "custom": the property's own mailbox (host, port, security, user,
 *   encrypted password, From).
 * - `console`: logs instead of sending. Local development and tests only; in
 *   production it is neither offered nor honoured (a stored `console` row is
 *   treated as `platform`).
 */
const PROVIDER_PLATFORM = 'platform';
const PROVIDER_CUSTOM = 'smtp';
const PROVIDER_CONSOLE = 'console';

const SEND_TIMEOUTS = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000, dnsTimeout: 10000 };

let smtpTransport = null;

/** Pure transport construction. `servername` keeps certificate checks on the NAME when we connect to a vetted IP. */
function buildTransport({ host, port, user, password, security, servername }) {
  if (!host) {
    throw new Error('SMTP_HOST is required to send mail over SMTP (see .env.example, or a property’s own email settings).');
  }
  const mode = security ?? (port === 465 ? 'tls' : 'starttls');
  return nodemailer.createTransport({
    host,
    port,
    // Port 465 / "tls" is implicit TLS; "starttls" must upgrade or the send fails (never plain).
    secure: mode === 'tls',
    requireTLS: mode === 'starttls',
    tls: { minVersion: 'TLSv1.2', ...(servername ? { servername } : {}) },
    auth: user ? { user, pass: password } : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
    ...SEND_TIMEOUTS,
  });
}

function buildSmtpTransport() {
  if (!smtpTransport) {
    smtpTransport = buildTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      security: Number(process.env.SMTP_PORT || 587) === 465 ? 'tls' : 'starttls',
    });
  }
  return smtpTransport;
}

async function sendViaTransport(transport, { to, subject, html, attachments, fromAddress, fromName, replyTo }) {
  if (!fromAddress || !isSingleEmailAddress(fromAddress)) {
    throw new Error('A valid SMTP "From" address is required (SMTP_FROM/SMTP_USER, or the property’s own email settings).');
  }
  // A display name makes a mailbox whose local part reads oddly for transactional
  // mail present as a real sender; it is sanitised so it can never add a header.
  const info = await transport.sendMail({
    from: { name: sanitizeDisplayName(fromName), address: fromAddress },
    ...(replyTo && isSingleEmailAddress(replyTo) ? { replyTo } : {}),
    to,
    subject,
    html,
    text: htmlToText(html),
    ...(attachments?.length ? { attachments } : {}),
  });
  return { providerRef: info.messageId, status: 'sent' };
}

/** The server env's own mailbox, used by platform-level mail (backups) and as the platform sender's transport. */
const smtpAdapter = {
  name: 'smtp',
  async send({ to, subject, html, attachments }) {
    const transport = buildSmtpTransport();
    return sendViaTransport(transport, {
      to,
      subject,
      html,
      attachments,
      fromAddress: process.env.SMTP_FROM || process.env.SMTP_USER,
      fromName: process.env.SMTP_FROM_NAME || 'LodgeKeep',
    });
  },
};

const ADAPTERS = { console: consoleAdapter, smtp: smtpAdapter };

/** `EMAIL_PROVIDER` env var selects the server-level adapter; defaults to `console` (no credentials required). */
function getEmailAdapter() {
  const name = process.env.EMAIL_PROVIDER || 'console';
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unknown EMAIL_PROVIDER "${name}" — no adapter registered in src/modules/notifications/email-adapter.js.`);
  }
  return adapter;
}

/**
 * Whether the platform mailbox is fully configured in the server env, and
 * what is missing. The missing names are for the server log and platform
 * staff only; tenants are only ever told "not configured on this server".
 */
function platformSmtpStatus(env = process.env) {
  const missing = [];
  if (env.EMAIL_PROVIDER !== 'smtp') missing.push('EMAIL_PROVIDER=smtp');
  if (!env.SMTP_HOST) missing.push('SMTP_HOST');
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port <= 0) missing.push('SMTP_PORT');
  const from = env.SMTP_FROM || env.SMTP_USER;
  if (!from || !isSingleEmailAddress(from)) missing.push('SMTP_FROM');
  if (env.SMTP_USER && !env.SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
  return { configured: missing.length === 0, missing };
}

const PLATFORM_UNAVAILABLE_REASON = 'Not sent: the platform email service is not configured on this server. Ask the platform administrator to set it up, or use your own SMTP in Setup → Email, then resend.';

/** True when stored `email_settings.provider` selects the property's own mailbox. */
function isCustomRow(row) {
  return Boolean(row) && row.provider === PROVIDER_CUSTOM;
}

/** The effective mode for a row (or no row) in this environment: 'platform' | 'custom' | 'console'. */
function effectiveMode(row) {
  if (isCustomRow(row)) return 'custom';
  const production = process.env.NODE_ENV === 'production';
  // Development and tests only: with no platform SMTP in the server env, mail goes to the
  // console. (A stored `console` row, the old default, never overrides a configured platform mailbox.)
  if (!production && process.env.EMAIL_PROVIDER !== 'smtp') return 'console';
  return 'platform';
}

/** Property name and Reply-To for the platform sender. Reply-To is the property's saved contact address, else the first active super_admin's email. */
async function loadSenderIdentity({ db, propertyId, row }) {
  const property = propertyId && db ? await db.table('properties').where({ id: propertyId }).first() : null;
  let replyTo = row?.reply_to && isSingleEmailAddress(row.reply_to) ? row.reply_to : null;
  if (!replyTo && propertyId && db) {
    const grants = await db.table('user_property_access').where({ role: 'super_admin' }).orderBy('id');
    for (const grant of grants) {
      const user = await db.table('users').where({ id: grant.user_id }).first();
      if (user && user.status === 'active' && isSingleEmailAddress(user.email)) {
        replyTo = user.email;
        break;
      }
    }
  }
  return { displayName: sanitizeDisplayName(property?.name), replyTo };
}

function buildPlatformAdapter({ identity }) {
  const status = platformSmtpStatus();
  return {
    name: 'platform',
    mode: 'platform',
    unavailableReason: status.configured ? null : PLATFORM_UNAVAILABLE_REASON,
    platformMissing: status.missing,
    // The platform's own credentials and host never reach a tenant, even inside an error message.
    scrub: (text) => scrubSecrets(text, [process.env.SMTP_PASSWORD, process.env.SMTP_USER, process.env.SMTP_HOST]),
    async send({ to, subject, html, attachments }) {
      if (!status.configured) throw new Error(PLATFORM_UNAVAILABLE_REASON);
      return sendViaTransport(buildSmtpTransport(), {
        to,
        subject,
        html,
        attachments,
        // Forced: the From address is never taken from a tenant.
        fromAddress: process.env.SMTP_FROM || process.env.SMTP_USER,
        fromName: identity.displayName,
        replyTo: identity.replyTo,
      });
    },
  };
}

/** Not memoized: two properties can hold two different configurations. Resolves and vets the host at SEND time, then connects to that address. */
function buildCustomAdapter(row) {
  return {
    name: 'smtp',
    mode: 'custom',
    unavailableReason: null,
    scrub: (text) => {
      let password;
      try {
        password = row.smtp_password_encrypted ? decrypt(row.smtp_password_encrypted) : undefined;
      } catch {
        password = undefined;
      }
      return scrubSecrets(text, [password, row.smtp_user]);
    },
    async send({ to, subject, html, attachments }) {
      const port = Number(row.smtp_port || 587);
      assertAllowedPort(port);
      const security = SMTP_SECURITY_MODES.includes(row.smtp_security) ? row.smtp_security : port === 465 ? 'tls' : 'starttls';
      const { address } = await resolveSafeSmtpHost(row.smtp_host);
      const transport = buildTransport({
        host: address,
        servername: row.smtp_host,
        port,
        security,
        user: row.smtp_user,
        password: row.smtp_password_encrypted ? decrypt(row.smtp_password_encrypted) : undefined,
      });
      try {
        return await sendViaTransport(transport, {
          to,
          subject,
          html,
          attachments,
          fromAddress: row.smtp_from || row.smtp_user,
          fromName: row.smtp_from_name,
        });
      } finally {
        transport.close();
      }
    },
  };
}

/**
 * Picks the adapter for a property: its own mailbox ("custom"), the platform
 * mailbox, or — outside production only — the console. `db` must be a scoped
 * accessor bound to `propertyId`.
 */
async function resolveEmailAdapter({ db, propertyId }) {
  const row = propertyId && db ? await db.table('email_settings').where({ property_id: propertyId }).first() : null;
  const mode = effectiveMode(row);
  if (mode === 'custom') return buildCustomAdapter(row);
  if (mode === 'console') return consoleAdapter;
  return buildPlatformAdapter({ identity: await loadSenderIdentity({ db, propertyId, row }) });
}

/** Test-only teardown, closes the pooled SMTP connection so a test process can exit cleanly. */
function __closeSmtpTransportForTesting() {
  if (smtpTransport) {
    smtpTransport.close();
    smtpTransport = null;
  }
}

/**
 * Where a property's emails actually go, and whether that works right now.
 * `source`: 'custom' | 'platform' | 'none'. `platformConfigured` is only
 * meaningful for 'platform'. Never exposes credentials.
 */
async function describeEmailDelivery({ db, propertyId }) {
  const adapter = await resolveEmailAdapter({ db, propertyId });
  if (adapter.name === 'console') return { sendsEmail: false, source: 'none', mode: 'console', platformConfigured: platformSmtpStatus().configured };
  if (adapter.mode === 'custom') return { sendsEmail: true, source: 'custom', mode: 'custom', platformConfigured: platformSmtpStatus().configured };
  const configured = !adapter.unavailableReason;
  return { sendsEmail: configured, source: configured ? 'platform' : 'none', mode: 'platform', platformConfigured: configured };
}

/**
 * True when "sending" through this adapter delivers nothing to anyone: the
 * log-only `console` adapter in production, or a platform mailbox that is not
 * (fully) configured on this server. Outside production the console adapter is
 * the intended local-development stand-in, so it still counts as sent there.
 */
function isUndeliverable(adapter) {
  if (adapter.unavailableReason) return true;
  return adapter.name === 'console' && process.env.NODE_ENV === 'production';
}

/** The message recorded when an email could not be sent because no mailbox is set up. */
const NO_MAILBOX_REASON = 'Not sent: no email mailbox is set up for this property. Add one in Setup → Email settings, then resend.';

/** Error text that is safe to store and show: secrets removed. */
function safeErrorText(adapter, error) {
  const text = String(error?.message ?? error);
  return typeof adapter?.scrub === 'function' ? adapter.scrub(text) : scrubSecrets(text, []);
}

/** Why this adapter cannot send (shown in the delivery log). */
function undeliverableReason(adapter) {
  return adapter.unavailableReason || NO_MAILBOX_REASON;
}

/** Refusing to "send" through no mailbox at all (a resend, a test email). 422: a business rule, not bad input. */
class NoMailboxConfiguredError extends AppError {
  constructor(reason = NO_MAILBOX_REASON) {
    super('BUSINESS_RULE_EMAIL_NO_MAILBOX', reason, 422);
  }
}

/** A send the mailbox refused or could not complete; the message has secrets removed. */
class EmailSendFailedError extends AppError {
  constructor(reason) {
    super('EMAIL_SEND_FAILED', `The email could not be sent: ${reason}`, 502);
  }
}

module.exports = {
  EmailSendFailedError,
  getEmailAdapter,
  resolveEmailAdapter,
  describeEmailDelivery,
  isUndeliverable,
  undeliverableReason,
  safeErrorText,
  platformSmtpStatus,
  effectiveMode,
  scrubSecrets,
  PROVIDER_PLATFORM,
  PROVIDER_CUSTOM,
  PROVIDER_CONSOLE,
  NO_MAILBOX_REASON,
  PLATFORM_UNAVAILABLE_REASON,
  NoMailboxConfiguredError,
  consoleAdapter,
  smtpAdapter,
  htmlToText,
  __closeSmtpTransportForTesting,
};
