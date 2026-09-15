'use strict';

/**
 * Recurring-expense sweep's transport — mirrors
 * `src/jobs/door-access-retention.js` exactly: the sweep LOGIC
 * (`expenses/recurrence.js`'s `postDueExpenseForSchedule`) is fully
 * testable against real MySQL with no live queue; this file is only the
 * BullMQ wiring around it — `upsertJobScheduler`, not `Queue#add({repeat})`,
 * a silent no-op against this codebase's installed BullMQ v6.
 *
 * "Which properties" is a bootstrapping question with no tenant context yet
 * to ask it through — reads `properties`/`tenants` directly via `knex()`,
 * the same exception `trial-expiry.js`/`door-access-retention.js`'s own
 * headers already document. A property with no `current_business_date`
 * configured yet is excluded entirely — there is no "today" to compare a
 * schedule's `next_due_date` against.
 *
 * Every property's due schedules are read and posted inside ONE
 * transaction per property — the plain read of due rows is not itself a
 * lock, but `postDueExpenseForSchedule` re-locks and re-checks EACH
 * schedule individually before posting, so a schedule already claimed by a
 * genuinely concurrent tick (a second server process, a manual re-trigger)
 * is safely skipped rather than double-posted.
 *
 * One `audit_log` row per property per tick, but ONLY when something was
 * actually posted — the same `if (posted > 0)` discipline every other
 * periodic sweep in this codebase already uses. A failure at one property
 * is logged and never stops the rest.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { expenseSchedulesQueue, EXPENSE_SCHEDULES_QUEUE } = require('./queues');
const { knex, scopedDb } = require('../db');
const { workerContext } = require('../modules/tenancy');
const { recordAuditEntry } = require('../audit');
const { postDueExpenseForSchedule } = require('../modules/expenses/recurrence');
const { recordExpense } = require('../modules/expenses/service');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const SWEEP_SCHEDULER_ID = 'expense-schedules-sweep';

/** One pass over every active property with a real current business date, posting every recurring schedule due there. Returns the total number of expenses posted across all of them. */
async function runExpenseSchedulesSweep() {
  const properties = await knex()('properties')
    .join('tenants', 'tenants.id', 'properties.tenant_id')
    .where('properties.status', 'active')
    .whereNot('tenants.status', 'offboarding')
    .whereNotNull('properties.current_business_date')
    .select('properties.id as id', 'properties.tenant_id as tenant_id', 'properties.current_business_date as business_date');

  let totalPosted = 0;
  for (const property of properties) {
    try {
      const context = workerContext({ tenantId: property.tenant_id, propertyId: property.id });
      const db = scopedDb().for(context);
      const posted = await db.transaction(async (trx) => {
        const due = await trx
          .table('recurring_expense_schedules')
          .where({ status: 'active' })
          .where('next_due_date', '<=', property.business_date)
          .orderBy('id'); // deterministic order, matching this codebase's own global lock-ordering discipline
        let count = 0;
        for (const schedule of due) {
          const result = await postDueExpenseForSchedule({ trx, recordExpense, schedule, businessDate: property.business_date });
          if (result.posted) count += 1;
        }
        return count;
      });
      if (posted > 0) {
        totalPosted += posted;
        await recordAuditEntry(scopedDb().for(context), {
          propertyId: property.id,
          entityType: 'recurring_expense_schedules',
          entityId: null,
          action: 'expense_schedule_auto_post',
          source: 'job',
          afterState: { postedCount: posted, businessDate: property.business_date },
        });
      }
    } catch (error) {
      console.error(`Expense schedule sweep failed for property ${property.id}:`, error);
    }
  }
  return totalPosted;
}

/** Registers the repeatable sweep job — call once at process startup. `upsertJobScheduler` is itself idempotent by id, so calling this once per server restart is correct and safe to repeat. */
async function scheduleExpenseSchedulesSweep() {
  await expenseSchedulesQueue().upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every: SWEEP_INTERVAL_MS },
    { name: SWEEP_JOB_NAME, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );
}

function startExpenseSchedulesWorker() {
  return new Worker(
    EXPENSE_SCHEDULES_QUEUE,
    async () => {
      await runExpenseSchedulesSweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runExpenseSchedulesSweep,
  scheduleExpenseSchedulesSweep,
  startExpenseSchedulesWorker,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
};
