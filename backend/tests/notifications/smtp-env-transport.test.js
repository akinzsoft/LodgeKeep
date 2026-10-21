'use strict';

/**
 * The platform SMTP transport is fully env-driven and provider-neutral, and an existing
 * .env (SMTP_PASSWORD, SMTP_FROM, port-derived security) behaves exactly as before.
 * nodemailer's network layer is the only thing mocked.
 */

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const nodemailer = require('nodemailer');
const {
  smtpAdapter,
  platformSmtpEnv,
  platformSmtpStatus,
  __closeSmtpTransportForTesting,
} = require('../../src/modules/notifications/email-adapter');
const { logPlatformEmailTransport, warnAboutPlatformEmail } = require('../../src/shared/startup-checks');

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'do-not-leak-this-secret-value';

function resetEnv(extra = {}) {
  process.env = { ...ORIGINAL_ENV };
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PASSWORD', 'SMTP_FROM', 'MAIL_FROM_ADDRESS', 'SMTP_FROM_NAME', 'PLATFORM_REPLY_TO']) delete process.env[key];
  Object.assign(process.env, extra);
  __closeSmtpTransportForTesting();
}

describe('platform SMTP env', () => {
  let sendMail;
  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({ messageId: '<id>' });
    nodemailer.createTransport.mockReset().mockReturnValue({ sendMail, close: jest.fn() });
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
    __closeSmtpTransportForTesting();
  });

  const transportOptions = () => nodemailer.createTransport.mock.calls[0][0];

  it('existing env (SMTP_PASSWORD, SMTP_FROM, port 587) behaves exactly as before', async () => {
    resetEnv({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'mail.host.example', SMTP_PORT: '587', SMTP_USER: 'box@planmsys.com', SMTP_PASSWORD: SECRET, SMTP_FROM: 'noreply@planmsys.com' });
    await smtpAdapter.send({ to: 'x@example.com', subject: 's', html: '<p>hi</p>' });
    expect(transportOptions()).toMatchObject({ host: 'mail.host.example', port: 587, secure: false, requireTLS: true, auth: { user: 'box@planmsys.com', pass: SECRET }, disableFileAccess: true, disableUrlAccess: true });
    expect(sendMail.mock.calls[0][0].from).toEqual({ name: 'LodgeKeep', address: 'noreply@planmsys.com' });
    expect(platformSmtpStatus().configured).toBe(true);
  });

  it('port 465 is implicit TLS without any SMTP_SECURE', async () => {
    resetEnv({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h.example', SMTP_PORT: '465', SMTP_USER: 'u@planmsys.com', SMTP_PASSWORD: SECRET });
    await smtpAdapter.send({ to: 'x@example.com', subject: 's', html: '<p>hi</p>' });
    expect(transportOptions()).toMatchObject({ secure: true, requireTLS: false });
    // From falls back to SMTP_USER exactly as before.
    expect(sendMail.mock.calls[0][0].from.address).toBe('u@planmsys.com');
  });

  it('the new names work: SMTP_PASS, SMTP_SECURE, MAIL_FROM_ADDRESS (which wins over SMTP_FROM)', async () => {
    resetEnv({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.provider.example', SMTP_PORT: '2465', SMTP_SECURE: 'true', SMTP_USER: 'apikey', SMTP_PASS: SECRET, SMTP_PASSWORD: 'old', MAIL_FROM_ADDRESS: 'lodgekeep@planmsys.com', SMTP_FROM: 'other@planmsys.com' });
    await smtpAdapter.send({ to: 'x@example.com', subject: 's', html: '<p>hi</p>' });
    expect(transportOptions()).toMatchObject({ host: 'smtp.provider.example', port: 2465, secure: true, auth: { user: 'apikey', pass: SECRET } });
    expect(sendMail.mock.calls[0][0].from.address).toBe('lodgekeep@planmsys.com');
  });

  it('SMTP_SECURE=false forces STARTTLS even on 465; an unset value follows the port', () => {
    expect(platformSmtpEnv({ SMTP_PORT: '465', SMTP_SECURE: 'false' }).security).toBe('starttls');
    expect(platformSmtpEnv({ SMTP_PORT: '587', SMTP_SECURE: 'tls' }).security).toBe('tls');
    expect(platformSmtpEnv({ SMTP_PORT: '465' }).security).toBe('tls');
    expect(platformSmtpEnv({}).security).toBe('starttls');
  });

  it('a provider SMTP user that is not an address falls back to lodgekeep@planmsys.com as From', () => {
    expect(platformSmtpEnv({ SMTP_USER: 'resend' }).from).toBe('lodgekeep@planmsys.com');
    expect(platformSmtpEnv({ SMTP_USER: 'box@planmsys.com' }).from).toBe('box@planmsys.com');
    expect(platformSmtpStatus({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'resend', SMTP_PASS: 'p' }).configured).toBe(true);
  });

  it('status names what is missing without any value', () => {
    const status = platformSmtpStatus({ EMAIL_PROVIDER: 'smtp', SMTP_USER: 'u@x.com', SMTP_PASS: '' });
    expect(status).toEqual({ configured: false, missing: ['SMTP_HOST', 'SMTP_PASS'] });
  });
});

describe('startup log lines never carry credentials', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('states the host, port and security, and nothing secret', () => {
    const lines = [];
    const env = { EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.provider.example', SMTP_PORT: '587', SMTP_USER: 'apikey-user-name', SMTP_PASS: SECRET, MAIL_FROM_ADDRESS: 'lodgekeep@planmsys.com' };
    const line = logPlatformEmailTransport(env, (l) => lines.push(l));
    expect(line).toBe('[email] platform mail transport: smtp host=smtp.provider.example port=587 security=starttls');
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain('apikey-user-name');
  });

  it('a non-SMTP provider is stated without a host', () => {
    const lines = [];
    expect(logPlatformEmailTransport({ EMAIL_PROVIDER: 'console' }, (l) => lines.push(l))).toBeNull();
    expect(lines[0]).toContain('console');
  });

  it('the not-configured warning never contains a value', () => {
    const lines = [];
    warnAboutPlatformEmail({ NODE_ENV: 'production', EMAIL_PROVIDER: 'smtp', SMTP_USER: 'apikey-user-name', SMTP_PASS: '' }, (l) => lines.push(l));
    expect(lines.join('\n')).not.toContain('apikey-user-name');
  });
});
