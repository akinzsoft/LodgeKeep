'use strict';

/**
 * Night-audit "overdue" sweep — gap closure, user-requested ("if night
 * audit have not been run at the appropriate time it shld send
 * notification including mail"). Confirmed with the user (AskUserQuestion)
 * before building: "overdue" means the property's own
 * `current_business_date` has gone stale — it's already a new calendar day
 * in the property's OWN timezone and that date still hasn't been closed by
 * a night audit run. This codebase has no "night audit should run by
 * HH:MM" schedule anywhere, and none was added — this works the moment it
 * ships, no new Setup field to configure. Checked hourly; exactly one bell
 * + one email per property per stale business date, never repeated (also
 * confirmed).
 *
 * Mirrors `src/jobs/door-access-retention.js`'s exact shape: `knex()`
 * direct join for "which properties" (no tenant context yet to ask
 * through — the same bootstrapping exception that file's own header
 * documents), a per-property try/catch so one property's failure never
 * stops the rest, `upsertJobScheduler` (not `Queue#add({repeat})`, a
 * silent no-op against this codebase's installed BullMQ v6).
 *
 * Bell + email, not bell-only like `notifications-sweep.js`'s own
 * departing-balance alert — the user explicitly asked for mail this time.
 * Follows `access-monitoring/service.js`'s `notifyCriticalAlerts` shape
 * exactly for combining both: `notifyStaff` (bell, subject to the Setup
 * grid's own `night_audit.overdue` role overrides) plus a direct,
 * independent manager/admin/super_admin `writeOutboxEvent` loop for email
 * — a digest-style send doesn't fit `notifyStaff`'s one-row-per-recipient
 * bell shape, and email recipients are deliberately NOT grid-configurable,
 * the same split `door_access.critical_alerts_detected` already
 * established.
 *
 * Dedup: `writeOutboxEvent` has no dedup-key mechanism of its own (unlike
 * `notifyStaff`'s `in_app_notifications.dedup_key`), so "exactly once per
 * property per stale date" is enforced by checking the property's own most
 * recent `audit_log` row for this action first — more robust than relying
 * on the bell's own dedup insert succeeding, which would stay silently
 * empty forever (and so never actually prevent a resend) if every
 * recipient role were turned off on the Setup grid for this one event. The
 * audit row is written regardless of how many recipients actually existed
 * (even zero) — it marks "this property+date was evaluated," not "someone
 * was successfully told."
 *
 * The check-then-write itself (read the last alert, then notify + write
 * the audit row) is wrapped in one transaction that locks the property row
 * first (`SELECT ... FOR UPDATE`) — otherwise two genuinely overlapping
 * sweep ticks (a slow prior run still finishing when the next hourly tick
 * fires) could both pass the "already alerted?" check before either
 * writes, double-sending the email. Proven under real concurrent
 * connections in `tests/jobs/night-audit-overdue-sweep.test.js`, the same
 * discipline `door-access-retention.js`'s own concurrency test already
 * established for its purge.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { nightAuditOverdueQueue, NIGHT_AUDIT_OVERDUE_QUEUE } = require('./queues');
const { knex, scopedDb } = require('../db');
const { INACTIVE_SWEEP_STATUSES } = require('../shared/tenant-lifecycle');
const { workerContext } = require('../modules/tenancy');
const { recordAuditEntry } = require('../audit');
const { writeOutboxEvent } = require('../shared/outbox');
const { calendarDateInZone } = require('../shared/timezone');
const { notifyStaff } = require('../modules/notifications/staff-notifications');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = 60 * 60_000; // hourly, confirmed with the user
const SWEEP_SCHEDULER_ID = 'night-audit-overdue-sweep';

// Independent of `night_audit.overdue`'s own bell defaultRoles/Setup-grid
// overrides — the email side always targets this fixed set, the same
// deliberate split `notifyCriticalAlerts` already established for
// `door_access.critical_alerts_detected`.
const NOTIFIED_ROLES = Object.freeze(['manager', 'admin', 'super_admin']);
const ALERTED_ACTION = 'night_audit_overdue_alerted';

function overdueDedupKey(propertyId, businessDate) {
  return `night_audit_overdue:property:${propertyId}:${businessDate}`;
}

/**
 * One pass over every active property with a real `current_business_date`.
 * Returns how many properties were newly alerted this tick.
 */
async function runNightAuditOverdueSweep() {
  const properties = await knex()('properties')
    .join('tenants', 'tenants.id', 'properties.tenant_id')
    .where('properties.status', 'active')
    .whereNotIn('tenants.status', INACTIVE_SWEEP_STATUSES)
    .whereNotNull('properties.current_business_date')
    .select(
      'properties.id as id',
      'properties.tenant_id as tenant_id',
      'properties.name as name',
      'properties.timezone as timezone',
      'properties.current_business_date as current_business_date'
    );

  let alertedCount = 0;
  for (const property of properties) {
    try {
      const todayInPropertyTz = calendarDateInZone(new Date(), property.timezone);
      if (!(property.current_business_date < todayInPropertyTz)) continue; // not overdue

      const context = workerContext({ tenantId: property.tenant_id, propertyId: property.id });
      const db = scopedDb().for(context);

      // Concurrency: two genuinely overlapping sweep ticks (a slow prior
      // run still finishing when the next hourly tick fires) must not both
      // pass the "already alerted?" check and double-send — the property
      // row is the one natural lock target here, the same
      // `SELECT ... FOR UPDATE`-serializes-the-check-and-write shape this
      // codebase already uses for plan-entitlement checks. Proven under
      // real concurrent connections in this job's own test file.
      const alreadyAlerted = await db.transaction(async (trx) => {
        await trx.table('properties').where({ id: property.id }).forUpdate().first();

        const lastAlert = await trx
          .table('audit_log')
          .where({ entity_type: 'properties', entity_id: property.id, action: ALERTED_ACTION })
          .orderBy('id', 'desc')
          .first();
        if (lastAlert?.after_state?.businessDate === property.current_business_date) return true;

        const rows = await trx
          .table('user_property_access')
          .whereIn('role', NOTIFIED_ROLES)
          .joinScoped('users', (join) => join.on('user_property_access.user_id', '=', 'users.id'))
          .where('users.status', 'active')
          .select('users.id as id', 'users.email as email', 'users.first_name as first_name');
        const recipients = [...new Map(rows.map((row) => [String(row.id), row])).values()];

        await notifyStaff({
          trx,
          eventType: 'night_audit.overdue',
          payload: { propertyName: property.name, businessDate: property.current_business_date, todayInPropertyTz },
          dedupKey: overdueDedupKey(property.id, property.current_business_date),
        });

        for (const recipient of recipients) {
          if (!recipient.email) continue;
          await writeOutboxEvent({
            trx,
            eventType: 'night_audit.overdue',
            aggregateType: 'properties',
            aggregateId: property.id,
            propertyId: property.id,
            payload: {
              recipientEmail: recipient.email,
              recipientName: recipient.first_name,
              propertyName: property.name,
              businessDate: property.current_business_date,
            },
          });
        }

        await recordAuditEntry(trx, {
          propertyId: property.id,
          entityType: 'properties',
          entityId: property.id,
          action: ALERTED_ACTION,
          source: 'job',
          afterState: { businessDate: property.current_business_date, recipientCount: recipients.length },
        });
        return false;
      });
      if (!alreadyAlerted) alertedCount += 1;
    } catch (error) {
      console.error(`Night audit overdue sweep failed for property ${property.id}:`, error);
    }
  }
  return alertedCount;
}

/**
 * Registers the repeatable sweep job — call once at process startup.
 * `upsertJobScheduler` is itself idempotent by id, so calling this once per
 * server restart (unchanged call-site behaviour) is correct and safe to
 * repeat.
 */
async function scheduleNightAuditOverdueSweep() {
  await nightAuditOverdueQueue().upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every: SWEEP_INTERVAL_MS },
    { name: SWEEP_JOB_NAME, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );
}

function startNightAuditOverdueWorker() {
  return new Worker(
    NIGHT_AUDIT_OVERDUE_QUEUE,
    async () => {
      await runNightAuditOverdueSweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runNightAuditOverdueSweep,
  scheduleNightAuditOverdueSweep,
  startNightAuditOverdueWorker,
  overdueDedupKey,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
};
