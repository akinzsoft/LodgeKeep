'use strict';

/**
 * Bug fix, user-reported on production: a staff invitation from a property
 * with no email settings of its own was "sent" through the server's default
 * console adapter — written to the server log, recorded as sent, and never
 * delivered. In production that is now recorded as NOT sent, with the
 * reason, straight away (no retries — nothing can change until a mailbox
 * is set up), and never reaches the adapter. Real adapters, no mocks: the
 * fixture's `properties[0]` mailbox is the console adapter, and the test
 * environment pins EMAIL_PROVIDER=console.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { workerContext } = require('../../src/modules/tenancy');
const { writeOutboxEvent } = require('../../src/shared/outbox');
const { scopedDb } = require('../../src/db');
const { dispatchPendingOutboxEventsForTenant, resendNotification } = require('../../src/modules/notifications/service');
const { NO_MAILBOX_REASON } = require('../../src/modules/notifications/email-adapter');

describe('dispatch with no mailbox configured', () => {
  const t = useTestApp();
  let ctx;
  let originalEnv;
  let logSpy;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    logSpy.mockRestore();
  });

  function context() {
    return workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id });
  }

  async function queueInvitation(email) {
    return writeOutboxEvent({
      trx: scopedDb().for(context()),
      eventType: 'staff.invited',
      aggregateType: 'user_invitations',
      aggregateId: 1,
      propertyId: ctx.a.properties[0].id,
      payload: { guestEmail: email, invitationUrl: 'https://example.com/invite', role: 'front_desk', propertyName: 'Alpha' },
    });
  }

  it('in production, records the email as not sent, with the reason, and never "sends" it into the log', async () => {
    process.env.NODE_ENV = 'production';
    const eventId = await queueInvitation('invitee-prod@example.com');

    await dispatchPendingOutboxEventsForTenant({ context: context() });

    const event = await t.trx('outbox_events').where({ id: eventId }).first();
    expect(event.status).toBe('failed');
    expect(event.last_error).toBe(NO_MAILBOX_REASON);
    const log = await t.trx('notification_log').where({ recipient_email: 'invitee-prod@example.com' }).first();
    expect(log).toMatchObject({ status: 'failed', failed_reason: NO_MAILBOX_REASON, template_key: 'staff_invitation' });
    expect(logSpy.mock.calls.some(([line]) => String(line).includes('invitee-prod@example.com'))).toBe(false);
  });

  it('in production, Resend on an unsent email refuses with the same reason instead of "sending" it again', async () => {
    process.env.NODE_ENV = 'production';
    await queueInvitation('invitee-resend@example.com');
    await dispatchPendingOutboxEventsForTenant({ context: context() });
    const log = await t.trx('notification_log').where({ recipient_email: 'invitee-resend@example.com' }).first();

    await expect(resendNotification({ context: context(), id: log.id })).rejects.toMatchObject({ code: 'BUSINESS_RULE_EMAIL_NO_MAILBOX', httpStatus: 422 });
    expect(Number((await t.trx('notification_log').where({ recipient_email: 'invitee-resend@example.com' }).count('* as n').first()).n)).toBe(1);
  });

  it('outside production, the console adapter is still the intended stand-in: logged and recorded as sent', async () => {
    process.env.NODE_ENV = 'development';
    const eventId = await queueInvitation('invitee-dev@example.com');

    await dispatchPendingOutboxEventsForTenant({ context: context() });

    const event = await t.trx('outbox_events').where({ id: eventId }).first();
    expect(event.status).toBe('sent');
    const log = await t.trx('notification_log').where({ recipient_email: 'invitee-dev@example.com' }).first();
    expect(log.status).toBe('sent');
  });
});
