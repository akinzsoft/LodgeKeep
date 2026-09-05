'use strict';

/**
 * HTTP-level tests for the notifications module — the admin template
 * editor, the delivery log with its resend action, the in-app bell, and
 * RBAC gating across the two new permission keys.
 *
 * The email adapter is mocked here too (see `dispatch.test.js`'s own
 * header for why) so `resendNotification`'s real send attempt does not
 * depend on the `console` adapter's exact log output.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

jest.mock('../../src/modules/notifications/email-adapter', () => ({
  getEmailAdapter: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ providerRef: 'resend-ref', status: 'sent' }) })),
}));

describe('Notifications (PLAN.md Phase 3)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  /** users[0] holds `manager` at properties[0] — read-only notifications access per this pass's grant. */
  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, propertyIndex, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  describe('template editor', () => {
    it('manager cannot edit templates (read-only), admin can', async () => {
      const managerAttempt = await t.request
        .put('/api/v1/notifications/templates')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ template_key: 'reservation_cancelled', subject: 'Cancelled', body_html: '<p>Cancelled.</p>' });
      expect(managerAttempt.status).toBe(403);

      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'admin' });
      const adminToken = tokenFor({ userId: ctx.a.users[1].id });

      const created = await t.request
        .put('/api/v1/notifications/templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ template_key: 'reservation_cancelled', subject: 'Your booking is cancelled', body_html: '<p>Sorry to see you go.</p>' });
      expect(created.status).toBe(200);
      expect(created.body.data.subject).toBe('Your booking is cancelled');

      const updated = await t.request
        .put('/api/v1/notifications/templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ template_key: 'reservation_cancelled', subject: 'Updated subject', body_html: '<p>Updated.</p>' });
      expect(updated.status).toBe(200);
      expect(updated.body.data.subject).toBe('Updated subject');
      expect(updated.body.data.id).toBe(created.body.data.id);
    });
  });

  describe('delivery log & resend', () => {
    let failedLogId;

    beforeAll(async () => {
      const [id] = await t.trx('notification_log').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        recipient_email: 'bounced-guest@example.com',
        template_key: 'reservation_confirmed',
        channel: 'email',
        status: 'failed',
        failed_reason: 'Mailbox does not exist',
        reservation_id: ctx.a.reservations[0].id,
      });
      failedLogId = id;
    });

    it('manager can view the delivery log, filtered by status', async () => {
      const res = await t.request
        .get('/api/v1/notifications/log')
        .query({ status: 'failed' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((row) => String(row.id) === String(failedLogId))).toBe(true);
      expect(res.body.data.every((row) => row.status === 'failed')).toBe(true);
    });

    it('manager cannot resend (manage-only); admin can', async () => {
      const managerAttempt = await t.request
        .post(`/api/v1/notifications/log/${failedLogId}/resend`)
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(managerAttempt.status).toBe(403);

      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'admin' });
      const adminToken = tokenFor({ userId: ctx.a.users[1].id });

      const resent = await t.request.post(`/api/v1/notifications/log/${failedLogId}/resend`).set('Authorization', `Bearer ${adminToken}`);
      expect(resent.status).toBe(201);
      expect(resent.body.data.status).toBe('sent');
      expect(resent.body.data.recipient_email).toBe('bounced-guest@example.com');

      // The original failed row is untouched — a new attempt, not a rewrite.
      const original = await t.trx('notification_log').where({ id: failedLogId }).first();
      expect(original.status).toBe('failed');
    });

    it('404s on a cross-tenant notification log id, never 403', async () => {
      const [otherId] = await t.trx('notification_log').insert({
        tenant_id: ctx.b.id,
        property_id: ctx.b.properties[0].id,
        recipient_email: 'other-tenant@example.com',
        template_key: 'reservation_confirmed',
        channel: 'email',
        status: 'sent',
        sent_at: new Date(),
      });
      // Admin (holds notifications.manage) — proves this is a 404 from the
      // cross-tenant scope check, not a 403 from the permission gate.
      const adminToken = tokenFor({ userId: ctx.a.users[1].id });
      const res = await t.request.post(`/api/v1/notifications/log/${otherId}/resend`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('in-app bell', () => {
    it('every authenticated staff member reads only their own notifications, no permission required', async () => {
      await t.trx('in_app_notifications').insert([
        { tenant_id: ctx.a.id, user_id: ctx.a.users[0].id, type: 'housekeeping.discrepancy_raised', payload: JSON.stringify({}) },
        { tenant_id: ctx.a.id, user_id: ctx.a.users[1].id, type: 'housekeeping.discrepancy_raised', payload: JSON.stringify({}) },
      ]);

      const mine = await t.request.get('/api/v1/notifications/bell').set('Authorization', `Bearer ${tokenFor()}`);
      expect(mine.status).toBe(200);
      expect(mine.body.data.every((n) => String(n.user_id) === String(ctx.a.users[0].id))).toBe(true);
      expect(mine.body.data.length).toBeGreaterThan(0);
    });

    it('marks a notification read, and 404s on another user\'s notification id', async () => {
      const [id] = await t.trx('in_app_notifications').insert({
        tenant_id: ctx.a.id,
        user_id: ctx.a.users[0].id,
        type: 'housekeeping.discrepancy_raised',
        payload: JSON.stringify({}),
      });

      const marked = await t.request.post(`/api/v1/notifications/bell/${id}/read`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(marked.status).toBe(200);
      expect(marked.body.data.read_at).not.toBeNull();

      const [otherUsersNotification] = await t.trx('in_app_notifications').insert({
        tenant_id: ctx.a.id,
        user_id: ctx.a.users[1].id,
        type: 'housekeeping.discrepancy_raised',
        payload: JSON.stringify({}),
      });
      const wrongUser = await t.request
        .post(`/api/v1/notifications/bell/${otherUsersNotification}/read`)
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(wrongUser.status).toBe(404);
    });
  });
});
