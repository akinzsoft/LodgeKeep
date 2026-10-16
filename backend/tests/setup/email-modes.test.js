'use strict';

/**
 * Email modes per property: "platform" (default; the platform's own SMTP) and
 * "custom" (the property's own SMTP). Covers the guards: no credential in any
 * response, the From address forced in platform mode, header injection, the
 * SSRF/port/TLS rules for custom hosts, the platform send limits (and their
 * exemption for sign-in mail), console refused in production, failures that
 * stay visible, Resend of old "sent into the log" invitations, audit rows and
 * tenant isolation.
 *
 * The real nodemailer builds each message (stream transport), so header
 * assertions are made on the actual raw message, not on our own arguments.
 */

const dns = require('dns').promises;
const nodemailer = require('nodemailer');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { workerContext } = require('../../src/modules/tenancy');
const { writeOutboxEvent } = require('../../src/shared/outbox');
const { scopedDb } = require('../../src/db');
const { rateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');
const { dispatchPendingOutboxEventsForTenant, resendNotification } = require('../../src/modules/notifications/service');
const { resolveEmailAdapter, __closeSmtpTransportForTesting } = require('../../src/modules/notifications/email-adapter');
const { warnAboutPlatformEmail } = require('../../src/shared/startup-checks');

const PLATFORM_ENV = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.platform-secret-host.example',
  SMTP_PORT: '587',
  SMTP_USER: 'platform-user@platform.example',
  SMTP_PASSWORD: 'platform-password-xyz',
  SMTP_FROM: 'noreply@platform.example',
  SMTP_FROM_NAME: 'LodgeKeep',
};

/** Undoes quoted-printable so assertions can look for plain text such as a link. */
const decoded = (raw) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

describe('Email modes: platform and custom SMTP', () => {
  const t = useTestApp();
  const realCreateTransport = nodemailer.createTransport;
  const ORIGINAL_ENV = { ...process.env };
  let ctx;
  let sent; // raw messages built by real nodemailer
  let transportArgs;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('user_property_access').where({ user_id: tenant.users[0].id, property_id: tenant.properties[1].id }).update({ role: 'admin' });
    }
  });

  beforeEach(async () => {
    sent = [];
    transportArgs = [];
    Object.assign(process.env, PLATFORM_ENV);
    delete process.env.SMTP_ALLOW_PRIVATE_HOSTS;
    __closeSmtpTransportForTesting();
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.114.9', family: 4 }]);
    jest.spyOn(nodemailer, 'createTransport').mockImplementation((options) => {
      transportArgs.push(options);
      const stream = realCreateTransport({ streamTransport: true, buffer: true, newline: 'unix' });
      return {
        async sendMail(message) {
          const info = await stream.sendMail(message);
          sent.push(info.message.toString());
          return { messageId: info.messageId };
        },
        close() {},
      };
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // The harness rolls back per FILE, so each test re-establishes its own state.
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('outbox_events').where({ tenant_id: tenant.id }).del();
      await t.trx('notification_log').where({ tenant_id: tenant.id }).del();
      await t.trx('user_invitations').where({ tenant_id: tenant.id }).del();
      await t.trx('email_settings').where({ tenant_id: tenant.id, property_id: tenant.properties[1].id }).del();
      await t.trx('properties').where({ id: tenant.properties[1].id }).update({ name: 'Grand Palm Hotel' });
    }
    const redis = rateLimitRedisConnection();
    const keys = await redis.keys('emailq:*');
    if (keys.length) await redis.del(...keys);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    __closeSmtpTransportForTesting();
  });

  function token(tenant = ctx.a, userIndex = 0, propertyIndex = 1) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[userIndex].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[propertyIndex].id),
    });
  }
  const put = (body, tk = token()) => t.request.put('/api/v1/email-settings').set('Authorization', `Bearer ${tk}`).send(body);

  function ctxFor(tenant, propertyIndex = 1) {
    return workerContext({ tenantId: tenant.id, propertyId: tenant.properties[propertyIndex].id });
  }
  /** Staff-invitation events need a live invitation row behind their link (a Resend refuses a dead link). */
  async function liveInvitationFor(tenant, email, url, propertyIndex) {
    const token = /invite_token=([^&#]+)/.exec(url ?? '')?.[1];
    if (!token) return 1;
    const [id] = await t.trx('user_invitations').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[propertyIndex].id,
      email,
      role: 'front_desk',
      token_hash: require('crypto').createHash('sha256').update(token).digest('hex'),
      expires_at: new Date(Date.now() + 86400000),
      invited_by_user_id: tenant.users[0].id,
    });
    return id;
  }

  async function queue(tenant, eventType, email, payload = {}, propertyIndex = 1) {
    const aggregateId = eventType === 'staff.invited' ? await liveInvitationFor(tenant, email, payload.invitationUrl, propertyIndex) : 1;
    return writeOutboxEvent({
      trx: scopedDb().for(ctxFor(tenant, propertyIndex)),
      eventType,
      aggregateType: eventType === 'staff.invited' ? 'user_invitations' : 'test',
      aggregateId,
      propertyId: tenant.properties[propertyIndex].id,
      payload: { guestEmail: email, guestName: 'Guest', ...payload },
    });
  }
  const dispatch = (tenant = ctx.a, propertyIndex = 1) => dispatchPendingOutboxEventsForTenant({ context: ctxFor(tenant, propertyIndex) });

  describe('mode rules', () => {
    it('defaults to platform, and console is refused in production but accepted in development', async () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const refused = await put({ mode: 'console' });
        expect(refused.status).toBe(400);
        expect(refused.body.error.code).toBe('VALIDATION_EMAIL_SETTINGS_INVALID');
      } finally {
        process.env.NODE_ENV = original;
      }
      const ok = await put({ mode: 'console' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.mode).toBe('console');
      const platform = await put({ mode: 'platform' });
      expect(platform.body.data).toMatchObject({ mode: 'platform', provider: 'platform' });
      const unknown = await put({ mode: 'carrier-pigeon' });
      expect(unknown.status).toBe(400);
    });

    it('in production a stored console row and a property with no row both resolve to the platform mailbox', async () => {
      await t.trx('email_settings').where({ property_id: ctx.a.properties[0].id }).update({ provider: 'console' });
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const db = scopedDb().for(ctxFor(ctx.a, 0));
        expect((await resolveEmailAdapter({ db, propertyId: ctx.a.properties[0].id })).name).toBe('platform');
        // Even with EMAIL_PROVIDER=console in the server env, production never uses the console.
        process.env.EMAIL_PROVIDER = 'console';
        const consoleEnv = await resolveEmailAdapter({ db, propertyId: ctx.a.properties[0].id });
        expect(consoleEnv.name).toBe('platform');
        expect(consoleEnv.unavailableReason).toBeTruthy();
        process.env.EMAIL_PROVIDER = 'smtp';
        const noRow = scopedDb().for(ctxFor(ctx.b, 1));
        expect((await resolveEmailAdapter({ db: noRow, propertyId: ctx.b.properties[1].id })).name).toBe('platform');
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    it('requires setup.manage (a manager is refused) and never touches another tenant', async () => {
      await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[1].id }).del();
      await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[1].id, user_id: ctx.a.users[1].id, role: 'manager' });
      const manager = await put({ mode: 'platform' }, token(ctx.a, 1));
      expect(manager.status).toBe(403);

      await put({ mode: 'platform', reply_to: 'a-owner@example.com' });
      const other = await t.request.get('/api/v1/email-settings').set('Authorization', `Bearer ${token(ctx.b)}`);
      expect(other.body.data).toBeNull();
      const countB = await t.trx('email_settings').where({ tenant_id: ctx.b.id, property_id: ctx.b.properties[1].id }).count('* as n').first();
      expect(Number(countB.n)).toBe(0);
    });
  });

  describe('platform mode: credentials and sender', () => {
    it('never exposes platform credentials in any response, status, or test result', async () => {
      await put({ mode: 'platform' });
      const responses = [
        await t.request.get('/api/v1/email-settings').set('Authorization', `Bearer ${token()}`),
        await t.request.get('/api/v1/email-settings/status').set('Authorization', `Bearer ${token()}`),
        await t.request.post('/api/v1/email-settings/test').set('Authorization', `Bearer ${token()}`).send({}),
      ];
      for (const res of responses) {
        const text = JSON.stringify(res.body);
        for (const secret of ['platform-password-xyz', 'platform-user@platform.example', 'smtp.platform-secret-host.example']) {
          expect(text).not.toContain(secret);
        }
      }
      expect(responses[2].status).toBe(200);
    });

    it('a failing platform send never leaks the platform host, user or password in the error', async () => {
      nodemailer.createTransport.mockReturnValue({
        sendMail: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED smtp.platform-secret-host.example:587 user platform-user@platform.example password=platform-password-xyz')),
        close: jest.fn(),
      });
      await put({ mode: 'platform' });
      const res = await t.request.post('/api/v1/email-settings/test').set('Authorization', `Bearer ${token()}`).send({});
      expect(res.status).toBe(400);
      const text = JSON.stringify(res.body);
      for (const secret of ['platform-password-xyz', 'platform-user@platform.example', 'smtp.platform-secret-host.example']) {
        expect(text).not.toContain(secret);
      }
      const row = await t.trx('email_settings').where({ property_id: ctx.a.properties[1].id }).first();
      expect(row.last_test_error).not.toContain('platform-password-xyz');
    });

    it('forces the From to the platform sender; the tenant name is only the display name; Reply-To is the tenant contact', async () => {
      await t.trx('properties').where({ id: ctx.a.properties[1].id }).update({ name: 'Grand Palm Hotel' });
      // A tenant tries to set its own From while in platform mode: ignored.
      const saved = await put({ mode: 'platform', smtp_from: 'ceo@bank.example', smtp_from_name: 'The Bank', reply_to: 'front@grandpalm.example' });
      expect(saved.body.data.smtp_from).toBeNull();
      // Even a custom From left in the row (e.g. from an earlier custom setup) is never used in platform mode.
      await t.trx('email_settings').where({ property_id: ctx.a.properties[1].id }).update({ smtp_from: 'ceo@bank.example', smtp_from_name: 'The Bank' });
      await queue(ctx.a, 'staff.invited', 'new@staff.example', { invitationUrl: 'https://x.example/i', propertyName: 'Grand Palm Hotel', role: 'front_desk' });
      await dispatch();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/^From: "?Grand Palm Hotel"? <noreply@platform\.example>$/m);
      expect(sent[0]).toMatch(/^Reply-To: front@grandpalm\.example$/m);
      expect(sent[0]).not.toContain('ceo@bank.example');
    });

    it('falls back to the first super_admin email for Reply-To when none is saved', async () => {
      await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[1].id }).del();
      await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[1].id, user_id: ctx.a.users[1].id, role: 'super_admin' });
      await put({ mode: 'platform', reply_to: null });
      await queue(ctx.a, 'staff.invited', 'n@staff.example', { invitationUrl: 'https://x.example/i' });
      await dispatch();
      expect(sent[0]).toContain(`Reply-To: ${ctx.a.users[1].email}`);
    });

    it('a property name containing a newline cannot add headers', async () => {
      await t.trx('properties').where({ id: ctx.a.properties[1].id }).update({ name: 'Evil Inn\r\nBcc: victim@example.com\r\nX-Injected: yes' });
      await put({ mode: 'platform', reply_to: 'front@evil.example' });
      await queue(ctx.a, 'staff.invited', 'n@staff.example', { invitationUrl: 'https://x.example/i' });
      await dispatch();
      const headers = sent[0].split('\n\n')[0];
      // Every header line is a known header or a folded continuation; none was injected.
      const names = headers.split('\n').filter((line) => /^\S/.test(line)).map((line) => line.split(':')[0].toLowerCase());
      expect(names.every((n) => ['from', 'to', 'reply-to', 'subject', 'message-id', 'date', 'mime-version', 'content-type'].includes(n))).toBe(true);
      expect(headers).not.toMatch(/^Bcc:/im);
      expect(headers).not.toMatch(/^X-Injected:/im);
      // The display name itself had its line breaks removed.
      expect(headers).toMatch(/^From: "Evil Inn Bcc: victim@example\.com X-Injected: yes"/m);
    });

    it('rejects a Reply-To that is not one plain address (control characters, lists, names)', async () => {
      for (const bad of ['a@b.com\r\nBcc: x@y.com', 'a@b.com, c@d.com', 'Name <a@b.com>', 'not-an-email']) {
        const res = await put({ mode: 'platform', reply_to: bad });
        expect(res.status).toBe(400);
      }
    });
  });

  describe('custom mode: validation and safety', () => {
    const custom = (extra = {}) => ({ mode: 'custom', smtp_host: 'mail.hotel.example', smtp_port: 587, smtp_user: 'me@hotel.example', smtp_password: 'custom-pw-123', ...extra });

    it('stores the password encrypted, never returns it, and audits the change with the password masked', async () => {
      const res = await put(custom());
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ mode: 'custom', smtp_password_set: true, smtp_security: 'starttls' });
      expect(JSON.stringify(res.body)).not.toContain('custom-pw-123');
      expect(res.body.data).not.toHaveProperty('smtp_password_encrypted');
      const listed = await t.request.get('/api/v1/email-settings').set('Authorization', `Bearer ${token()}`);
      expect(listed.body.data).not.toHaveProperty('smtp_password_encrypted');
      expect(JSON.stringify(listed.body)).not.toMatch(/[A-Za-z0-9+/=]{10,}\.[A-Za-z0-9+/=]{10,}\.[A-Za-z0-9+/=]{4,}/);
      const row = await t.trx('email_settings').where({ property_id: ctx.a.properties[1].id }).first();
      expect(row.smtp_password_encrypted).not.toContain('custom-pw-123');
      const audit = await t.trx('audit_log').where({ entity_type: 'email_settings' }).orderBy('id', 'desc').first();
      const after = typeof audit.after_state === 'string' ? JSON.parse(audit.after_state) : audit.after_state;
      expect(after).toMatchObject({ mode: 'custom', smtp_password: '***set***' });
      expect(JSON.stringify(audit)).not.toContain('custom-pw-123');
      expect(JSON.stringify(audit)).not.toContain(row.smtp_password_encrypted);

      await put({ mode: 'platform' });
      const audit2 = await t.trx('audit_log').where({ entity_type: 'email_settings' }).orderBy('id', 'desc').first();
      const before2 = typeof audit2.before_state === 'string' ? JSON.parse(audit2.before_state) : audit2.before_state;
      const after2 = typeof audit2.after_state === 'string' ? JSON.parse(audit2.after_state) : audit2.after_state;
      expect(before2).toMatchObject({ mode: 'custom' });
      expect(after2).toMatchObject({ mode: 'platform' });
    });

    it('blocks private, loopback, link-local and metadata hosts, and names that resolve to them', async () => {
      for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.10', '169.254.169.254', '[::1]', '172.16.0.9']) {
        const res = await put(custom({ smtp_host: host }));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_SMTP_HOST_REJECTED');
      }
      dns.lookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      const rebinding = await put(custom({ smtp_host: 'looks-public.example' }));
      expect(rebinding.status).toBe(400);
    });

    it('re-checks the host at SEND time (DNS answers can change after saving) and connects to the vetted address', async () => {
      await put(custom());
      const adapter = await resolveEmailAdapter({ db: scopedDb().for(ctxFor(ctx.a)), propertyId: ctx.a.properties[1].id });
      await adapter.send({ to: 'x@y.example', subject: 's', html: '<p>h</p>' });
      expect(transportArgs.at(-1)).toMatchObject({ host: '203.0.114.9', tls: expect.objectContaining({ servername: 'mail.hotel.example' }) });
      dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(adapter.send({ to: 'x@y.example', subject: 's', html: 'h' })).rejects.toMatchObject({ code: 'VALIDATION_SMTP_HOST_REJECTED' });
    });

    it('allows only ports 25, 465, 587 and 2525', async () => {
      for (const port of [22, 80, 3306, 6379, 8080]) {
        const res = await put(custom({ smtp_port: port }));
        expect(res.status).toBe(400);
      }
      for (const port of [25, 465, 587, 2525]) {
        expect((await put(custom({ smtp_port: port }))).status).toBe(200);
      }
    });

    it('enforces TLS: implicit TLS or required STARTTLS, with TLS 1.2+, and sets timeouts', async () => {
      await put(custom({ smtp_port: 465, smtp_security: 'tls' }));
      let adapter = await resolveEmailAdapter({ db: scopedDb().for(ctxFor(ctx.a)), propertyId: ctx.a.properties[1].id });
      await adapter.send({ to: 'x@y.example', subject: 's', html: 'h' });
      expect(transportArgs.at(-1)).toMatchObject({ secure: true, requireTLS: false, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 });
      expect(transportArgs.at(-1).tls.minVersion).toBe('TLSv1.2');

      await put(custom({ smtp_port: 587, smtp_security: 'starttls' }));
      adapter = await resolveEmailAdapter({ db: scopedDb().for(ctxFor(ctx.a)), propertyId: ctx.a.properties[1].id });
      await adapter.send({ to: 'x@y.example', subject: 's', html: 'h' });
      expect(transportArgs.at(-1)).toMatchObject({ secure: false, requireTLS: true });

      const plain = await put(custom({ smtp_security: 'none' }));
      expect(plain.status).toBe(400);
    });

    it('uses the tenant\'s own From in custom mode, and refuses an invalid From', async () => {
      expect((await put(custom({ smtp_from: 'a@b.com\r\nBcc: x@y.com' }))).status).toBe(400);
      await put(custom({ smtp_from: 'bookings@hotel.example', smtp_from_name: 'Hotel "Quote"\r\nBcc: z@z.com' }));
      const adapter = await resolveEmailAdapter({ db: scopedDb().for(ctxFor(ctx.a)), propertyId: ctx.a.properties[1].id });
      await adapter.send({ to: 'x@y.example', subject: 's', html: 'h' });
      const headers = sent[0].split('\n\n')[0];
      expect(headers).toContain('<bookings@hotel.example>');
      expect(headers).not.toMatch(/^Bcc:/im);
    });
  });

  describe('platform send limits', () => {
    beforeEach(() => {
      process.env.PLATFORM_EMAIL_DAILY_CAP = '2';
    });

    it('caps reservation/AR mail per tenant per day with a visible reason, while sign-in mail is exempt', async () => {
      await put({ mode: 'platform' });
      for (let i = 0; i < 3; i += 1) await queue(ctx.a, 'reservation.confirmed', `guest${i}@x.example`, { confirmationNumber: `C${i}` });
      await dispatch();
      const events = await t.trx('outbox_events').where({ event_type: 'reservation.confirmed', tenant_id: ctx.a.id }).orderBy('id');
      expect(events.map((e) => e.status)).toEqual(['sent', 'sent', 'failed']);
      expect(events[2].last_error).toMatch(/Daily email limit reached/);
      const log = await t.trx('notification_log').where({ recipient_email: 'guest2@x.example' }).first();
      expect(log).toMatchObject({ status: 'failed' });
      expect(log.failed_reason).toMatch(/Daily email limit/);

      // The cap is hit, yet an invitation, a password-reset code and an MFA code still go out.
      await queue(ctx.a, 'staff.invited', 'invitee@x.example', { invitationUrl: 'https://x.example/i' });
      await queue(ctx.a, 'staff.password_reset_code_requested', 'reset@x.example', { code: '111111' });
      await queue(ctx.a, 'staff.mfa_code_requested', 'mfa@x.example', { code: '222222' });
      await dispatch();
      const critical = await t.trx('outbox_events').whereIn('event_type', ['staff.invited', 'staff.password_reset_code_requested', 'staff.mfa_code_requested']).where({ tenant_id: ctx.a.id });
      expect(critical.map((e) => e.status)).toEqual(['sent', 'sent', 'sent']);
    });

    it('the cap is per tenant: another tenant is unaffected', async () => {
      await put({ mode: 'platform' });
      for (let i = 0; i < 3; i += 1) await queue(ctx.a, 'reservation.confirmed', `a${i}@x.example`);
      await dispatch();
      await queue(ctx.b, 'reservation.confirmed', 'b0@x.example');
      await dispatch(ctx.b);
      const b = await t.trx('outbox_events').where({ tenant_id: ctx.b.id, event_type: 'reservation.confirmed' }).first();
      expect(b.status).toBe('sent');
    });

    it('limits sign-in mail per recipient (mailbombing) and per minute, and keeps retrying later', async () => {
      process.env.PLATFORM_EMAIL_RECIPIENT_LIMIT = '2';
      for (let i = 0; i < 3; i += 1) await queue(ctx.a, 'staff.mfa_code_requested', 'same@x.example', { code: `10000${i}` });
      await dispatch();
      const rows = await t.trx('outbox_events').where({ event_type: 'staff.mfa_code_requested', tenant_id: ctx.a.id }).orderBy('id');
      expect(rows.map((e) => e.status)).toEqual(['sent', 'sent', 'pending']);
      expect(rows[2].last_error).toMatch(/Too many emails to this address/);
    });

    it('custom mode is not capped by us', async () => {
      await put({ mode: 'custom', smtp_host: 'mail.hotel.example', smtp_port: 587, smtp_user: 'me@hotel.example', smtp_password: 'pw' });
      for (let i = 0; i < 4; i += 1) await queue(ctx.a, 'reservation.confirmed', `c${i}@x.example`);
      await dispatch();
      const rows = await t.trx('outbox_events').where({ event_type: 'reservation.confirmed', tenant_id: ctx.a.id });
      expect(rows.every((e) => e.status === 'sent')).toBe(true);
    });

    it('shows the day\'s usage against the cap in the status', async () => {
      await put({ mode: 'platform' });
      await queue(ctx.a, 'reservation.confirmed', 'u@x.example');
      await dispatch();
      const res = await t.request.get('/api/v1/email-settings/status').set('Authorization', `Bearer ${token()}`);
      expect(res.body.data.usage).toEqual({ sentToday: 1, dailyCap: 2 });
    });

    it('a capped test email returns a clear 429', async () => {
      process.env.PLATFORM_EMAIL_RECIPIENT_LIMIT = '1';
      await put({ mode: 'platform' });
      expect((await t.request.post('/api/v1/email-settings/test').set('Authorization', `Bearer ${token()}`).send({})).status).toBe(200);
      const second = await t.request.post('/api/v1/email-settings/test').set('Authorization', `Bearer ${token()}`).send({});
      expect(second.status).toBe(429);
      expect(second.body.error.message).toMatch(/Too many emails/);
    });
  });

  describe('platform SMTP missing in production: visible failure, then Resend', () => {
    let env;
    beforeEach(() => {
      env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      delete process.env.SMTP_HOST;
    });
    afterEach(() => {
      process.env.NODE_ENV = env;
    });

    it('fails the send, never marks it sent, never falls back to the console, and shows the reason', async () => {
      const id = await queue(ctx.a, 'staff.invited', 'revana-invitee@x.example', { invitationUrl: 'https://x.example/?invite_token=abc', role: 'front_desk' });
      await dispatch();
      const event = await t.trx('outbox_events').where({ id }).first();
      expect(event.status).toBe('failed');
      expect(event.last_error).toMatch(/not configured on this server/);
      const log = await t.trx('notification_log').where({ recipient_email: 'revana-invitee@x.example' }).first();
      expect(log).toMatchObject({ status: 'failed', outbox_event_id: String(id) });
      expect(log.failed_reason).toMatch(/not configured on this server/);
      expect(console.log.mock.calls.some(([line]) => String(line).includes('revana-invitee@x.example'))).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('the status reports the platform mailbox as not configured, without naming env variables', async () => {
      await put({ mode: 'platform' });
      const res = await t.request.get('/api/v1/email-settings/status').set('Authorization', `Bearer ${token()}`);
      expect(res.body.data).toMatchObject({ sendsEmail: false, mode: 'platform', platformConfigured: false });
      expect(JSON.stringify(res.body)).not.toMatch(/SMTP_HOST/);
    });

    it('Resend of the failed invitation works once the server is configured, with the original link', async () => {
      await queue(ctx.a, 'staff.invited', 'resend-me@x.example', { invitationUrl: 'https://x.example/?invite_token=abc', role: 'front_desk', propertyName: 'Grand Palm' });
      await dispatch();
      const log = await t.trx('notification_log').where({ recipient_email: 'resend-me@x.example' }).first();
      process.env.SMTP_HOST = PLATFORM_ENV.SMTP_HOST; // the platform administrator fixes .env.production
      const resent = await resendNotification({ context: ctxFor(ctx.a), id: log.id });
      expect(resent.status).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(decoded(sent[0])).toContain('https://x.example/?invite_token=abc');
    });

    it('Resend also repairs an OLD invitation that was recorded as sent into the log (no event link on the row)', async () => {
      process.env.NODE_ENV = 'development';
      process.env.EMAIL_PROVIDER = 'console';
      await queue(ctx.a, 'staff.invited', 'old-revana@x.example', { invitationUrl: 'https://x.example/?invite_token=old', role: 'front_desk' });
      await dispatch(); // console adapter: logged and "sent", like production before this fix
      const log = await t.trx('notification_log').where({ recipient_email: 'old-revana@x.example' }).first();
      expect(log.status).toBe('sent');
      await t.trx('notification_log').where({ id: log.id }).update({ outbox_event_id: null }); // as rows written before this change
      Object.assign(process.env, PLATFORM_ENV);
      process.env.NODE_ENV = 'production';
      const resent = await resendNotification({ context: ctxFor(ctx.a), id: log.id });
      expect(resent.status).toBe('sent');
      expect(decoded(sent[0])).toContain('https://x.example/?invite_token=old');
    });
  });

  describe('startup warning', () => {
    it('logs loudly when production platform SMTP is incomplete, and stays quiet otherwise', () => {
      const log = jest.fn();
      expect(warnAboutPlatformEmail({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console' }, log)).toMatch(/PLATFORM EMAIL IS NOT CONFIGURED/);
      expect(log).toHaveBeenCalledTimes(1);
      expect(warnAboutPlatformEmail({ NODE_ENV: 'production', ...PLATFORM_ENV }, log)).toBeNull();
      expect(warnAboutPlatformEmail({ NODE_ENV: 'development' }, log)).toBeNull();
    });
  });
});
