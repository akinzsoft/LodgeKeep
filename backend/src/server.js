'use strict';

/**
 * The backend's process entrypoint. `src/app.js` exports `createApp()` and
 * nothing else — the test suite exercises it in-process via supertest,
 * bound to a rolled-back transaction (`tests/helpers/app.js`), and never
 * needed a real listening socket. A frontend talking to this backend over
 * HTTP does, which is what this file exists for.
 *
 * Deliberately thin: no logic lives here that isn't "start listening."
 */

require('dotenv').config();

const { createApp } = require('./app');
const { startOutboxWorker, scheduleOutboxSweep } = require('./jobs/outbox-dispatcher');
const { startTrialExpiryWorker, scheduleTrialExpirySweep } = require('./jobs/trial-expiry');
const { startSubscriptionBillingWorker, scheduleSubscriptionBillingSweep } = require('./jobs/subscription-billing');
const { startTenantDataExportWorker } = require('./jobs/tenant-data-export');
const { startDataImportWorker } = require('./jobs/data-import');
const { startNotificationsSweepWorker, scheduleNotificationsSweep } = require('./jobs/notifications-sweep');
const { startDoorAccessRetentionWorker, scheduleDoorAccessRetentionSweep } = require('./jobs/door-access-retention');
const { startExpenseSchedulesWorker, scheduleExpenseSchedulesSweep } = require('./jobs/expense-schedules');

const port = Number(process.env.PORT || 3000);

createApp().listen(port, () => {
  console.log(`Lodgekeep backend listening on :${port}`);
});

// PLAN.md Phase 3: the outbox dispatcher's worker and its durable periodic
// sweep (`src/jobs/outbox-dispatcher.js`'s own header explains both
// triggers). Started alongside the HTTP server, not gated behind a flag —
// Redis is already required infrastructure for this stack
// (docker-compose.yml), the same way the app already assumes MySQL is up.
startOutboxWorker();
scheduleOutboxSweep().catch((error) => {
  console.error('Failed to schedule the outbox dispatch sweep:', error);
});

// PLAN.md Phase 5: the trial-expiry sweep's worker and its periodic
// scheduler (`src/jobs/trial-expiry.js`'s own header). Same unconditional
// startup as the outbox worker above — Redis is already required
// infrastructure this stack assumes is up.
startTrialExpiryWorker();
scheduleTrialExpirySweep().catch((error) => {
  console.error('Failed to schedule the trial-expiry sweep:', error);
});

// PLAN.md Phase 5: the subscription-billing sweep's worker and its
// periodic scheduler (`src/jobs/subscription-billing.js`'s own header).
// Same unconditional startup as the two jobs above.
startSubscriptionBillingWorker();
scheduleSubscriptionBillingSweep().catch((error) => {
  console.error('Failed to schedule the subscription-billing sweep:', error);
});

// PLAN.md Phase 5 (tenant offboarding) — `src/jobs/tenant-data-export.js`'s
// own header. A one-off, reactive-only job (unlike the three above) — no
// periodic scheduler call here, since nothing sweeps for stuck exports in
// this pass (that file's own header flags this as a real, narrower gap).
startTenantDataExportWorker();

// PLAN.md Phase 5 (data migration) — `src/jobs/data-import.js`'s own
// header. A one-off, reactive-only job, the identical shape the export
// worker above already established — no periodic scheduler call here.
startDataImportWorker();

// Gap closure (staff notifications) — `src/jobs/notifications-sweep.js`'s
// own header. A periodic sweep raising the "departing today with an
// outstanding balance" bell alert, once per guest per business date.
startNotificationsSweepWorker();
scheduleNotificationsSweep().catch((error) => {
  console.error('Failed to schedule the notifications sweep:', error);
});

// PLAN.md Phase 7 gap closure (door access data retention) —
// `src/jobs/door-access-retention.js`'s own header. A once-daily sweep
// purging unreferenced door_access_events past a property's configured
// retention window; a property with no window set is never touched.
startDoorAccessRetentionWorker();
scheduleDoorAccessRetentionSweep().catch((error) => {
  console.error('Failed to schedule the door access retention sweep:', error);
});

// Expense tracking (greenfield feature) — a once-daily sweep auto-posting
// every recurring expense schedule (rent, salaries) due at a property's
// current business date, fully automatic, no manual approval gate.
startExpenseSchedulesWorker();
scheduleExpenseSchedulesSweep().catch((error) => {
  console.error('Failed to schedule the expense schedules sweep:', error);
});
