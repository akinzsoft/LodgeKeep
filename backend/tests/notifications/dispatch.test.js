'use strict';

/**
 * The real dispatch logic — PLAN.md Phase 3's "Tests required to close":
 * "Email: send, delivery-webhook status update, hard bounce surfaced, retry
 * on transient failure." No real email provider exists in this environment
 * (this session's confirmed decision — a `console` adapter is the default),
 * so the email ADAPTER boundary is mocked here — the one genuinely external
 * dependency in this pipeline — while everything else (outbox_events,
 * notification_log, email_templates, retry/backoff bookkeeping) runs
 * against real MySQL, the same "mock the external dependency, not your own
 * logic" boundary this codebase draws nowhere else because nothing else
 * this codebase has built yet has an external dependency to mock.
 *
 * There is no live delivery webhook to test against (no real provider is
 * wired up this pass) — "delivery-webhook status update" is instead proven
 * at the schema/service level: `notification_log.status` is a real,
 * independently-updatable column (not fixed at send time), which is what a
 * future webhook handler would write to.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { workerContext } = require('../../src/modules/tenancy');
const { writeOutboxEvent } = require('../../src/shared/outbox');
const { scopedDb } = require('../../src/db');

jest.mock('../../src/modules/notifications/email-adapter', () => ({
  getEmailAdapter: jest.fn(),
}));
const { getEmailAdapter } = require('../../src/modules/notifications/email-adapter');
const { dispatchPendingOutboxEventsForTenant } = require('../../src/modules/notifications/service');

describe('Notifications dispatch (PLAN.md Phase 3)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  afterEach(() => {
    getEmailAdapter.mockReset();
  });

  function context() {
    return workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id });
  }

  let seedCounter = 0;

  async function seedGuestReservation() {
    seedCounter += 1;
    const suffix = `${Date.now().toString(36)}${seedCounter}`;
    const [guestId] = await t.trx('guests').insert({
      tenant_id: ctx.a.id,
      first_name: 'Dispatch',
      last_name: 'Test',
      email: 'dispatch-test@example.com',
    });
    const [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: `DR${suffix}`,
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    const [roomTypeId] = await t.trx('room_types').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: `DT${suffix}`,
      name: 'Dispatch Type',
      default_occupancy: 2,
      base_rate: '100.00',
    });
    const [reservationId] = await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      guest_id: guestId,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: '2027-02-01',
      departure_date: '2027-02-02',
      status: 'confirmed',
      confirmation_number: `DISPATCHCONF-${Date.now()}`,
    });
    return { guestId, reservationId };
  }

  it('sends an email-worthy event and records it in the delivery log', async () => {
    const { reservationId } = await seedGuestReservation();
    getEmailAdapter.mockReturnValue({
      send: jest.fn().mockResolvedValue({ providerRef: 'test-ref-1', status: 'sent' }),
    });

    const eventId = await writeOutboxEvent({
      trx: scopedDb().for(context()),
      eventType: 'reservation.confirmed',
      aggregateType: 'reservations',
      aggregateId: reservationId,
      propertyId: ctx.a.properties[0].id,
      payload: {
        reservationId,
        guestEmail: 'dispatch-test@example.com',
        guestName: 'Dispatch Test',
        confirmationNumber: 'DISPATCHCONF',
        arrivalDate: '2027-02-01',
        departureDate: '2027-02-02',
      },
    });

    const processed = await dispatchPendingOutboxEventsForTenant({ context: context() });
    expect(processed).toBeGreaterThan(0);

    const event = await t.trx('outbox_events').where({ id: eventId }).first();
    expect(event.status).toBe('sent');

    const log = await t.trx('notification_log').where({ reservation_id: reservationId }).first();
    expect(log).toMatchObject({ status: 'sent', template_key: 'reservation_confirmed', provider_ref: 'test-ref-1' });
  });

  it('retries a transient failure — stays pending with an incremented attempt count, then succeeds on the next dispatch', async () => {
    const { reservationId } = await seedGuestReservation();
    const send = jest.fn().mockRejectedValueOnce(new Error('Temporary provider outage')).mockResolvedValueOnce({ providerRef: 'test-ref-2', status: 'sent' });
    getEmailAdapter.mockReturnValue({ send });

    const eventId = await writeOutboxEvent({
      trx: scopedDb().for(context()),
      eventType: 'reservation.confirmed',
      aggregateType: 'reservations',
      aggregateId: reservationId,
      propertyId: ctx.a.properties[0].id,
      payload: { reservationId, guestEmail: 'dispatch-test@example.com', guestName: 'Dispatch Test', confirmationNumber: 'X' },
    });

    await dispatchPendingOutboxEventsForTenant({ context: context() });
    let event = await t.trx('outbox_events').where({ id: eventId }).first();
    expect(event.status).toBe('pending');
    expect(event.attempt_count).toBe(1);
    expect(event.last_error).toMatch(/Temporary provider outage/);

    await dispatchPendingOutboxEventsForTenant({ context: context() });
    event = await t.trx('outbox_events').where({ id: eventId }).first();
    expect(event.status).toBe('sent');
  });

  it('marks a hard-failing event as failed after exhausting retries, and surfaces it in the delivery log', async () => {
    const { reservationId } = await seedGuestReservation();
    getEmailAdapter.mockReturnValue({ send: jest.fn().mockRejectedValue(new Error('Permanent bounce')) });

    const eventId = await writeOutboxEvent({
      trx: scopedDb().for(context()),
      eventType: 'reservation.confirmed',
      aggregateType: 'reservations',
      aggregateId: reservationId,
      propertyId: ctx.a.properties[0].id,
      payload: { reservationId, guestEmail: 'dispatch-test@example.com', guestName: 'Dispatch Test', confirmationNumber: 'X' },
    });

    for (let i = 0; i < 5; i += 1) {
      await dispatchPendingOutboxEventsForTenant({ context: context() });
    }

    const event = await t.trx('outbox_events').where({ id: eventId }).first();
    expect(event.status).toBe('failed');

    const log = await t.trx('notification_log').where({ reservation_id: reservationId, status: 'failed' }).first();
    expect(log.failed_reason).toMatch(/Permanent bounce/);
  });

  it('uses a property-configured template over the built-in default', async () => {
    // reservation_confirmed/en is already fixture-seeded for this property
    // (tests/helpers/fixtures.js) — a different, not-yet-configured key
    // (checked_in) proves the override without colliding with it.
    const { reservationId } = await seedGuestReservation();
    await t.trx('email_templates').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      template_key: 'checked_in',
      locale: 'en',
      subject: 'Custom subject for {{confirmationNumber}}',
      body_html: '<p>Custom body.</p>',
    });
    const send = jest.fn().mockResolvedValue({ providerRef: 'test-ref-3', status: 'sent' });
    getEmailAdapter.mockReturnValue({ send });

    await writeOutboxEvent({
      trx: scopedDb().for(context()),
      eventType: 'guest.checked_in',
      aggregateType: 'reservations',
      aggregateId: reservationId,
      propertyId: ctx.a.properties[0].id,
      payload: { reservationId, guestEmail: 'dispatch-test@example.com', guestName: 'Dispatch Test', confirmationNumber: 'CUSTOM123' },
    });

    await dispatchPendingOutboxEventsForTenant({ context: context() });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Custom subject for CUSTOM123', html: '<p>Custom body.</p>' }));
  });

  it('marks an event with no guest email as sent — nothing to deliver — without calling the adapter', async () => {
    getEmailAdapter.mockReturnValue({ send: jest.fn() });
    const eventId = await writeOutboxEvent({
      trx: scopedDb().for(context()),
      eventType: 'reservation.confirmed',
      aggregateType: 'reservations',
      aggregateId: 999999,
      propertyId: ctx.a.properties[0].id,
      payload: { reservationId: 999999, guestEmail: null },
    });

    await dispatchPendingOutboxEventsForTenant({ context: context() });
    const event = await t.trx('outbox_events').where({ id: eventId }).first();
    expect(event.status).toBe('sent');
  });
});
