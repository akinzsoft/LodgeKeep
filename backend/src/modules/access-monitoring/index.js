'use strict';

/**
 * Door access monitoring & occupancy fraud detection — PLAN.md Phase 7,
 * PRODUCT_REQUIREMENTS.md §3.23.
 *
 * Built for the confirmed hardware only: HiRead ProUSB, standalone offline
 * locks, `manual_import` ingestion. Detection is retrospective — it happens
 * when staff upload a lock audit trail, never live.
 *
 * Built: per-property lock config, a generic column-mapping import (.xls/
 * .xlsx/.csv), three rules (unsold_occupancy, post_checkout_access,
 * first-use-after-check-in confirmations), incident alerts with an
 * open/acknowledged/resolved lifecycle, and a digest email + bell to
 * manager/admin/super_admin.
 *
 * Deliberately not built (confirmed): vacant_room_accessed,
 * card_active_no_folio, ooo_room_accessed, staff_card_anomaly and payment
 * mismatch rules; webhook/polling adapters; the night-audit reconciliation
 * sweep (`service.evaluateEvents` is its reusable entry point); retention/
 * purge and field-level encryption of door events; a standalone room access
 * log screen.
 */

const { accessMonitoringRouter } = require('./routes');

module.exports = { accessMonitoringRouter };
