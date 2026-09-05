'use strict';

/**
 * Notifications module — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.21,
 * ARCHITECTURE.md §13's outbox pattern.
 *
 * Built this pass: the outbox tables, a real dispatch pipeline (template
 * render → pluggable email adapter → delivery log → retry/backoff →
 * failure), the admin template editor, the delivery log with a resend
 * action, and the in-app bell. The email adapter defaults to a `console`
 * implementation (this session's confirmed decision — no provider
 * credentials exist in this environment); swapping in a real provider is a
 * new adapter file, not a change to this module's own logic.
 *
 * Wired to exactly four events this pass — `reservation.confirmed`,
 * `reservation.cancelled`, `guest.checked_in`, `guest.checked_out` — the
 * ones the reservations module (the only module with real guest-facing
 * lifecycle events so far) actually emits. ARCHITECTURE.md §13's own list is
 * "not exhaustive... add an event type when a module genuinely needs one,"
 * not a target to pre-build against.
 *
 * Deliberately NOT built this pass: SMS/WhatsApp channels (PRODUCT_REQUIREMENTS.md
 * §3.21 names them as optional/pluggable, no tenant has one to enable yet),
 * a notification-settings screen (which events notify which roles — the
 * bell wiring in this pass is a fixed rule: every staff member at the
 * property, see `src/modules/housekeeping/service.js`'s own note), and
 * scheduled report delivery (§3.11 territory, needs Reporting to exist
 * first). A durable cross-process crash-recovery sweep for a lost
 * reactive-dispatch trigger is real future work — see
 * `src/jobs/outbox-dispatcher.js`'s own header for the exact boundary of
 * what is and is not built there.
 */

const { notificationsRouter } = require('./routes');

module.exports = { notificationsRouter };
