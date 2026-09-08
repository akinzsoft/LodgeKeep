'use strict';

/**
 * Gap closure (user-reported, live-tested): "i want the verification code
 * shld be send to account email not to show on the screen." Closing this
 * for real needed an actual delivery transport, not just the `console`
 * adapter this codebase's own header already flagged as a stopgap — this
 * suite covers the new `smtp` adapter (the user's own webhosting mailbox,
 * `EMAIL_PROVIDER=smtp`) and `isEmailDeliveryReal()`, the helper other
 * modules use to decide whether a "dev-only" disclosure is still honest to
 * show.
 *
 * `nodemailer` is the one genuinely external dependency here (an actual
 * SMTP connection) — mocked at that boundary only, the same "mock the
 * external dependency, not your own logic" line `dispatch.test.js` already
 * draws for the email adapter as a whole.
 */

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

const nodemailer = require('nodemailer');
const { getEmailAdapter, __closeSmtpTransportForTesting } = require('../../src/modules/notifications/email-adapter');

describe('email-adapter', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    nodemailer.createTransport.mockReset();
    // The transport is memoized per process — clear it so the next test's
    // own SMTP_* env vars are what actually get read on its first send.
    __closeSmtpTransportForTesting();
  });

  describe('getEmailAdapter', () => {
    it('defaults to the console adapter with no EMAIL_PROVIDER set', () => {
      delete process.env.EMAIL_PROVIDER;
      expect(getEmailAdapter().name).toBe('console');
    });

    it('selects the smtp adapter when EMAIL_PROVIDER=smtp', () => {
      process.env.EMAIL_PROVIDER = 'smtp';
      expect(getEmailAdapter().name).toBe('smtp');
    });

    it('throws on an unrecognised EMAIL_PROVIDER value', () => {
      process.env.EMAIL_PROVIDER = 'carrier-pigeon';
      expect(() => getEmailAdapter()).toThrow(/Unknown EMAIL_PROVIDER/);
    });
  });

  describe('smtpAdapter.send', () => {
    it('sends through a real nodemailer transport built from SMTP_* env vars', async () => {
      process.env.EMAIL_PROVIDER = 'smtp';
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '587';
      process.env.SMTP_USER = 'no-reply@example.com';
      process.env.SMTP_PASSWORD = 'secret';

      const sendMail = jest.fn().mockResolvedValue({ messageId: 'real-message-id-123' });
      nodemailer.createTransport.mockReturnValue({ sendMail, close: jest.fn() });

      const result = await getEmailAdapter().send({ to: 'guest@example.com', subject: 'Your code', html: '<p>123456</p>' });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          auth: { user: 'no-reply@example.com', pass: 'secret' },
        })
      );
      expect(sendMail).toHaveBeenCalledWith({
        from: 'no-reply@example.com',
        to: 'guest@example.com',
        subject: 'Your code',
        html: '<p>123456</p>',
      });
      expect(result).toEqual({ providerRef: 'real-message-id-123', status: 'sent' });
    });

    it('treats port 465 as implicit TLS (secure: true)', async () => {
      process.env.EMAIL_PROVIDER = 'smtp';
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '465';
      process.env.SMTP_USER = 'no-reply@example.com';
      process.env.SMTP_PASSWORD = 'secret';

      nodemailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockResolvedValue({ messageId: 'x' }), close: jest.fn() });
      await getEmailAdapter().send({ to: 'guest@example.com', subject: 's', html: 'h' });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
    });

    it('uses SMTP_FROM over SMTP_USER as the From address when both are set', async () => {
      process.env.EMAIL_PROVIDER = 'smtp';
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_USER = 'login-account@example.com';
      process.env.SMTP_FROM = 'bookings@lodgekeep-tenant.example.com';

      const sendMail = jest.fn().mockResolvedValue({ messageId: 'x' });
      nodemailer.createTransport.mockReturnValue({ sendMail, close: jest.fn() });
      await getEmailAdapter().send({ to: 'guest@example.com', subject: 's', html: 'h' });

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'bookings@lodgekeep-tenant.example.com' }));
    });

    it('rejects with a clear error when SMTP_HOST is missing rather than connecting to nothing', async () => {
      process.env.EMAIL_PROVIDER = 'smtp';
      delete process.env.SMTP_HOST;
      await expect(getEmailAdapter().send({ to: 'a@example.com', subject: 's', html: 'h' })).rejects.toThrow(/SMTP_HOST/);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('rejects with a clear error when neither SMTP_FROM nor SMTP_USER is set', async () => {
      process.env.EMAIL_PROVIDER = 'smtp';
      process.env.SMTP_HOST = 'smtp.example.com';
      delete process.env.SMTP_USER;
      delete process.env.SMTP_FROM;
      nodemailer.createTransport.mockReturnValue({ sendMail: jest.fn(), close: jest.fn() });
      await expect(getEmailAdapter().send({ to: 'a@example.com', subject: 's', html: 'h' })).rejects.toThrow(/SMTP_FROM/);
    });
  });
});
