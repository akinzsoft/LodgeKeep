'use strict';

/**
 * The staff-notifications sweep — gap closure (user-reported: the bell should
 * flag "rooms that are checking out that day with an outstanding balance").
 *
 * That is a standing condition, not an event at a mutation site, so a
 * periodic sweep raises it. Confirmed with the user: one alert per guest per
 * business date, never repeating. The durable guarantee is
 * `in_app_notifications`' UNIQUE(tenant_id, user_id, dedup_key) — the dedup
 * key names the reservation and the business date — so a rerun (the next
 * tick, a concurrent run, a BullMQ retry) is a caught no-op. Once the balance
 * is cleared the reservation drops out of the query; nothing re-alerts.
 *
 * Mirrors `trial-expiry.js`: the logic (`runDepartingBalanceSweep`) is a plain
 * function testable against real MySQL; this file's BullMQ wiring uses
 * `upsertJobScheduler` (the v6 API — `Queue#add({repeat})` is a silent no-op
 * there). "Which properties" is a bootstrapping question with no tenant
 * context yet, so it reads `properties` through `knex()` directly, the same
 * exception that file documents.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { notificationsSweepQueue, NOTIFICATIONS_SWEEP_QUEUE } = require('./queues');
const { knex, scopedDb } = require('../db');
const { workerContext } = require('../modules/tenancy');
const reservationsService = require('../modules/reservations/service');
const { notifyStaff } = require('../modules/notifications/staff-notifications');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_SCHEDULER_ID = 'notifications-sweep';

function departingBalanceDedupKey(reservationId, businessDate) {
  return `departing_balance:reservation:${reservationId}:${businessDate}`;
}

/**
 * One pass over every open property with a business date. A failure at one
 * property is logged and never stops the rest.
 *
 * @returns {Promise<number>} bell rows written this pass.
 */
async function runDepartingBalanceSweep() {
  const properties = await knex()('properties')
    .join('tenants', 'tenants.id', 'properties.tenant_id')
    .where('properties.status', 'active')
    .whereNot('tenants.status', 'offboarding')
    .whereNotNull('properties.current_business_date')
    .select('properties.id as id', 'properties.tenant_id as tenant_id');

  let written = 0;
  for (const property of properties) {
    try {
      const context = workerContext({ tenantId: property.tenant_id, propertyId: property.id });
      const { businessDate, rows } = await reservationsService.listDepartingWithOutstandingBalance({ context });
      if (!businessDate) continue;
      const db = scopedDb().for(context);
      for (const row of rows) {
        written += await notifyStaff({
          trx: db,
          eventType: 'front_desk.departing_balance_outstanding',
          dedupKey: departingBalanceDedupKey(row.id, businessDate),
          payload: {
            reservationId: row.id,
            confirmationNumber: row.confirmation_number,
            guestName: [row.guest_first_name, row.guest_last_name].filter(Boolean).join(' ') || null,
            roomNumber: row.room_number ?? null,
            balance: row.folio_balance,
            currency: row.folio_currency,
            businessDate,
          },
        });
      }
    } catch (error) {
      console.error(`Notifications sweep failed for property ${property.id}:`, error);
    }
  }
  return written;
}

async function scheduleNotificationsSweep() {
  await notificationsSweepQueue().upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every: SWEEP_INTERVAL_MS },
    { name: SWEEP_JOB_NAME, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );
}

function startNotificationsSweepWorker() {
  return new Worker(
    NOTIFICATIONS_SWEEP_QUEUE,
    async () => {
      await runDepartingBalanceSweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runDepartingBalanceSweep,
  departingBalanceDedupKey,
  scheduleNotificationsSweep,
  startNotificationsSweepWorker,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
};
