'use strict';

/**
 * Reply-To rule for outgoing mail, tested through the real dispatch pipeline (outbox event ->
 * template -> platform adapter -> transport); only nodemailer's network layer is mocked.
 *
 * - Platform mail (sign-in codes, resets, invitations, subscription/trial/billing notices):
 *   never the recipient's own address; PLATFORM_REPLY_TO, default info@planmsys.com, or none.
 * - Guest-facing mail sent for a hotel: the hotel's own contact, as before.
 * - A Reply-To equal to the To address is never set.
 */

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const nodemailer = require('nodemailer');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { workerContext } = require('../../src/modules/tenancy');
const { writeOutboxEvent } = require('../../src/shared/outbox');
const { scopedDb } = require('../../src/db');
const { dispatchPendingOutboxEventsForTenant } = require('../../src/modules/notifications/service');
const { __closeSmtpTransportForTesting } = require('../../src/modules/notifications/email-adapter');
const { audienceForEvent, platformReplyTo } = require('../../src/shared/email-audience');

const HOTEL_CONTACT = 'frontdesk@hotel.example';
const PLATFORM_TYPES = [
  'staff.mfa_code_requested',
  'staff.password_reset_code_requested',
  'staff.invited',
  'tenant.trial_started',
  'tenant.subscribed',
  'tenant.payment_recorded',
  'billing.payment_failed',
  'billing.subscription_suspended',
  'offboarding.purge_warning',
];
const GUEST_TYPES = ['reservation.confirmed', 'guest.checked_in', 'ar.invoice_generated'];

describe('Reply-To by mail type', () => {
  const t = useTestApp();
  let ctx;
  const ORIGINAL_ENV = { ...process.env };
  let sendMail;
  // Rate-limit counters live in Redis across runs, so each dispatch uses a recipient no earlier run used.
  const stamp = Date.now().toString(36);
  let run = 0;
  let n = 0;
  const unique = (label) => `${label}-${stamp}-${run}-${(n += 1)}@example.com`;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('email_settings').where({ property_id: ctx.a.properties[0].id }).update({ provider: 'platform', reply_to: HOTEL_CONTACT });
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.provider.example', SMTP_PORT: '587', SMTP_USER: 'apikey', SMTP_PASS: 'super-secret-pass', PLATFORM_EMAIL_AUTH_RATE_PER_MIN: '100000', PLATFORM_EMAIL_RATE_PER_MIN: '100000', PLATFORM_EMAIL_DAILY_CAP: '100000', PLATFORM_EMAIL_RECIPIENT_LIMIT: '100000' };
    run += 1;
    delete process.env.PLATFORM_REPLY_TO;
    sendMail = jest.fn().mockResolvedValue({ messageId: '<id@test>' });
    nodemailer.createTransport.mockReset().mockReturnValue({ sendMail, close: jest.fn() });
    __closeSmtpTransportForTesting();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    __closeSmtpTransportForTesting();
  });

  const context = () => workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id });

  async function dispatch(eventType, recipient) {
    await writeOutboxEvent({
      trx: scopedDb().for(context()),
      eventType,
      aggregateType: 'test',
      aggregateId: 1,
      propertyId: ctx.a.properties[0].id,
      payload: { recipientEmail: recipient, guestEmail: recipient, propertyName: 'Alpha', code: '123456', expiresInMinutes: 10 },
    });
    sendMail.mockClear();
    await dispatchPendingOutboxEventsForTenant({ context: context() });
    expect(sendMail).toHaveBeenCalledTimes(1);
    return sendMail.mock.calls[0][0];
  }

  describe.each(PLATFORM_TYPES)('platform mail: %s', (eventType) => {
    it('has the platform Reply-To, never the recipient, by default', async () => {
      const recipient = unique('person');
      const message = await dispatch(eventType, recipient);
      expect(message.to).toBe(recipient);
      expect(message.replyTo).toBe('info@planmsys.com');
      expect(message.replyTo).not.toBe(HOTEL_CONTACT);
    });

    it('uses PLATFORM_REPLY_TO when set, and none when it is set empty', async () => {
      process.env.PLATFORM_REPLY_TO = 'support@planmsys.com';
      expect((await dispatch(eventType, unique('a'))).replyTo).toBe('support@planmsys.com');
      process.env.PLATFORM_REPLY_TO = '';
      expect(await dispatch(eventType, unique('b'))).not.toHaveProperty('replyTo');
    });

    it('never sets Reply-To equal to the To address, even when that is the platform address', async () => {
      const message = await dispatch(eventType, 'INFO@planmsys.com');
      expect(message).not.toHaveProperty('replyTo');
    });
  });

  describe.each(GUEST_TYPES)('guest-facing mail: %s', (eventType) => {
    it("keeps the hotel's own contact as Reply-To", async () => {
      const message = await dispatch(eventType, unique('guest'));
      expect(message.replyTo).toBe(HOTEL_CONTACT);
    });

    it('never sets Reply-To equal to the To address', async () => {
      expect(await dispatch(eventType, HOTEL_CONTACT)).not.toHaveProperty('replyTo');
    });
  });

  it('classifies unknown event types as platform mail', () => {
    expect(audienceForEvent('something.new')).toBe('platform');
    expect(audienceForEvent('reservation.confirmed')).toBe('guest');
  });

  it('PLATFORM_REPLY_TO: default, override, empty, and invalid', () => {
    expect(platformReplyTo({})).toBe('info@planmsys.com');
    expect(platformReplyTo({ PLATFORM_REPLY_TO: ' help@planmsys.com ' })).toBe('help@planmsys.com');
    expect(platformReplyTo({ PLATFORM_REPLY_TO: '' })).toBeNull();
    expect(platformReplyTo({ PLATFORM_REPLY_TO: 'a@b.com, c@d.com' })).toBeNull();
  });
});
