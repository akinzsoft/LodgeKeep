'use strict';

/**
 * Door access monitoring service — PLAN.md Phase 7, PRODUCT_REQUIREMENTS.md
 * §3.23, scoped to the confirmed hardware: HiRead ProUSB, standalone offline,
 * `manual_import` only. Detection is RETROSPECTIVE by construction — it runs
 * when staff upload a lock audit trail pulled with the handheld reader, never
 * in real time. Every response that feeds a screen carries
 * `supportsRealtime: false` so no screen can imply otherwise.
 *
 * Import flow (stateless — nothing persists until commit):
 *   POST /door-access/imports/headers   file            → the file's real headers + distinct values
 *   POST /door-access/imports/preview   file + mapping  → parsed events, duplicates, unparseable, unmatched rooms
 *   POST /door-access/imports/commit    file + mapping  → events stored, rules run, alerts raised
 * The browser keeps the selected file and re-sends it; a lock pull is a few
 * thousand rows at most, so there is no run table, no disk storage and no
 * cleanup lifecycle (unlike Data Migration, whose multi-request duplicate
 * adjudication genuinely needs one).
 *
 * Concurrency (ARCHITECTURE.md §5): the whole commit runs in one transaction
 * that first takes `SELECT ... FOR UPDATE` on the property's single
 * `lock_system_config` row. Two overlapping uploads for the same property
 * therefore serialise completely: the second one's duplicate check and
 * incident extend-vs-create decision see the first one's committed rows,
 * so neither duplicate events nor split/duplicate incidents can result.
 * Proven with real concurrent connections in
 * tests/access-monitoring/concurrency.test.js. Acknowledge/resolve lock the
 * alert row and re-check its status under that lock.
 *
 * No `runIdempotentMutation`: uploading a file twice is a routine re-pull,
 * and the natural-key unique index on `door_access_events` is what makes it
 * harmless — the same reasoning Data Migration's upload already documents.
 */

const crypto = require('crypto');
const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { writeOutboxEvent } = require('../../shared/outbox');
const { enqueueOutboxDispatch } = require('../../jobs/outbox-dispatcher');
const { notifyStaff } = require('../notifications/staff-notifications');
const { calendarDateInZone } = require('../../shared/timezone');
const { readSpreadsheet, distinctValuesByHeader } = require('./spreadsheet');
const { TIMESTAMP_FORMATS, normalizeMapping, buildRoomIndex, extractEvents, eventKey } = require('./mapping');
const { classifyEvent, SEVERITY } = require('./rules');
const { LockSystemNotConfiguredError, InvalidAlertTransitionError } = require('./errors');

const ADAPTERS = Object.freeze(['none', 'hiread_prousb', 'generic_csv']);
const NOTIFIED_ROLES = Object.freeze(['manager', 'admin', 'super_admin']);
const ALERT_STATUSES = Object.freeze(['open', 'acknowledged', 'resolved']);
const INSERT_CHUNK = 500;

// ---------------------------------------------------------------------
// Lock system configuration
// ---------------------------------------------------------------------

function presentConfig(row, property) {
  return {
    id: row?.id ?? null,
    adapter: row?.adapter ?? 'none',
    ingestionMode: row?.ingestion_mode ?? null,
    postCheckoutGraceMinutes: row?.post_checkout_grace_minutes ?? 15,
    importMapping: row?.import_mapping ?? null,
    lastImportAt: row?.last_import_at ?? null,
    // Every adapter built so far is manual_import. Stated explicitly so the
    // frontend's retrospective-detection banner reads a fact, not a guess.
    supportsRealtime: false,
    timezone: property?.timezone ?? null,
  };
}

async function loadProperty(db, context) {
  return db.table('properties').where({ id: context.propertyId }).first();
}

async function getConfig({ context }) {
  const db = scopedDb().for(context);
  const row = await db.table('lock_system_config').first();
  return presentConfig(row, await loadProperty(db, context));
}

async function updateConfig({ context, adapter, postCheckoutGraceMinutes }) {
  const issues = [];
  if (adapter !== undefined && !ADAPTERS.includes(adapter)) issues.push({ field: 'adapter', issue: 'unsupported', allowed: ADAPTERS });
  const grace = postCheckoutGraceMinutes === undefined ? undefined : Number(postCheckoutGraceMinutes);
  if (grace !== undefined && (!Number.isInteger(grace) || grace < 0 || grace > 720)) {
    issues.push({ field: 'post_checkout_grace_minutes', issue: 'must_be_whole_minutes_between_0_and_720' });
  }
  if (issues.length) throw new ValidationError('DOOR_ACCESS_CONFIG_INVALID', 'The door access settings are invalid.', issues);

  const db = scopedDb().for(context);

  // Make sure the singleton row exists BEFORE taking the row lock. A
  // `SELECT ... FOR UPDATE` that matches nothing only takes a gap lock, and
  // two first-time saves would both pass it and collide on INSERT (a
  // deadlock or a duplicate-key 500). A plain insert that loses the race is
  // simply a duplicate, caught here; after it the row always exists to lock.
  let created = false;
  try {
    await db.table('lock_system_config').insert({ adapter: 'none', ingestion_mode: null });
    created = true;
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
  }

  return db.transaction(async (trx) => {
    const existing = await trx.table('lock_system_config').forUpdate().first();
    const changes = {};
    if (adapter !== undefined) {
      changes.adapter = adapter;
      changes.ingestion_mode = adapter === 'none' ? null : 'manual_import';
    }
    if (grace !== undefined) changes.post_checkout_grace_minutes = grace;
    if (Object.keys(changes).length) await trx.table('lock_system_config').where({ id: existing.id }).update(changes);

    const row = await trx.table('lock_system_config').first();
    const property = await loadProperty(trx, context);
    return { before: created ? null : presentConfig(existing, property), after: presentConfig(row, property) };
  });
}

// ---------------------------------------------------------------------
// Import: headers → preview → commit
// ---------------------------------------------------------------------

async function readHeaders({ context, buffer }) {
  const { headers, rows } = readSpreadsheet(buffer);
  const config = await getConfig({ context });
  const saved = config.importMapping;
  // Offer the saved mapping only when every column it names is in this file.
  const savedMatches =
    saved && [saved.roomColumn, saved.cardColumn, saved.timestampColumn, saved.cardTypeColumn, saved.resultColumn]
      .filter(Boolean)
      .every((column) => headers.includes(column));

  return {
    headers,
    rowCount: rows.length,
    distinctValues: distinctValuesByHeader(headers, rows),
    savedMapping: savedMatches ? saved : null,
    timestampFormats: Object.keys(TIMESTAMP_FORMATS),
    config,
  };
}

/** Parses the file against the property's own rooms/timezone and splits out already-stored events. */
async function analyseFile(db, context, { buffer, mapping: rawMapping }) {
  const { headers, rows } = readSpreadsheet(buffer);
  const mapping = normalizeMapping(rawMapping, headers);
  const property = await loadProperty(db, context);
  const rooms = await db.table('rooms').select('id', 'room_number', 'status');
  const extracted = extractEvents({ rows, mapping, roomIndex: buildRoomIndex(rooms), timeZone: property.timezone });

  let existingKeys = new Set();
  if (extracted.events.length) {
    const roomIds = [...new Set(extracted.events.map((e) => e.roomId))];
    const stored = await db
      .table('door_access_events')
      .whereIn('room_id', roomIds)
      .whereBetween('opened_at', [extracted.events[0].openedAt, extracted.events[extracted.events.length - 1].openedAt])
      .select('room_id', 'card_id', 'opened_at');
    existingKeys = new Set(stored.map((row) => eventKey(row.room_id, row.card_id, row.opened_at)));
  }
  const newEvents = extracted.events.filter((e) => !existingKeys.has(eventKey(e.roomId, e.cardId, e.openedAt)));

  return { property, mapping, rowCount: rows.length, extracted, newEvents };
}

function importCounts({ rowCount, extracted, newEvents, mapping }) {
  return {
    rowCount,
    parsedEventCount: extracted.events.length + extracted.duplicatesInFile,
    newEventCount: newEvents.length,
    duplicatesInFile: extracted.duplicatesInFile,
    duplicatesAlreadyImported: extracted.events.length - newEvents.length,
    unparseableCount: extracted.unparseable.length,
    unmatchedRoomRowCount: extracted.unmatchedRooms.reduce((sum, r) => sum + r.count, 0),
    unmatchedRooms: extracted.unmatchedRooms,
    cardTypeColumnMapped: Boolean(mapping.cardTypeColumn),
    guestEventCount: newEvents.filter((e) => e.isGuestCard && e.result !== 'denied').length,
    nonGuestEventCount: newEvents.filter((e) => !e.isGuestCard).length,
    deniedEventCount: newEvents.filter((e) => e.result === 'denied').length,
    earliestEventAt: newEvents[0]?.openedAt ?? null,
    latestEventAt: newEvents[newEvents.length - 1]?.openedAt ?? null,
  };
}

async function previewImport({ context, buffer, mapping }) {
  const db = scopedDb().for(context);
  const config = await db.table('lock_system_config').first();
  if (!config || config.adapter === 'none') throw new LockSystemNotConfiguredError();

  const analysis = await analyseFile(db, context, { buffer, mapping });
  return {
    mapping: analysis.mapping,
    ...importCounts(analysis),
    unparseableRows: analysis.extracted.unparseable.slice(0, 50),
    sampleEvents: analysis.newEvents.slice(0, 25).map((e) => ({
      rowNumber: e.rowNumber,
      roomNumber: e.roomNumber,
      cardId: e.cardId,
      cardType: e.cardType,
      isGuestCard: e.isGuestCard,
      result: e.result,
      openedAt: e.openedAt,
    })),
    supportsRealtime: false,
  };
}

async function commitImport({ context, buffer, mapping }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    // The serialisation point for every import at this property — see header.
    const config = await trx.table('lock_system_config').forUpdate().first();
    if (!config || config.adapter === 'none') throw new LockSystemNotConfiguredError();

    const analysis = await analyseFile(trx, context, { buffer, mapping });
    const importRef = crypto.randomUUID();

    for (let i = 0; i < analysis.newEvents.length; i += INSERT_CHUNK) {
      await trx.table('door_access_events').insert(
        analysis.newEvents.slice(i, i + INSERT_CHUNK).map((e) => ({
          room_id: e.roomId,
          lock_system: config.adapter,
          card_id: e.cardId,
          card_type: e.cardType,
          is_guest_card: e.isGuestCard,
          result: e.result,
          opened_at: e.openedAt,
          is_retrospective: true,
          import_ref: importRef,
          imported_by_user_id: context.userId,
        }))
      );
    }

    const stored = await trx.table('door_access_events').where({ import_ref: importRef }).orderBy('opened_at').orderBy('id');
    const evaluation = await evaluateEvents(trx, stored, {
      graceMinutes: config.post_checkout_grace_minutes,
      timeZone: analysis.property.timezone,
      importRef,
    });

    const criticalCreated = evaluation.createdAlerts.filter((a) => a.severity === SEVERITY.critical);
    const recipients = criticalCreated.length ? await notifyCriticalAlerts(trx, context, { config, property: analysis.property, alerts: criticalCreated, stored }) : [];

    await trx.table('lock_system_config').where({ id: config.id }).update({ import_mapping: JSON.stringify(analysis.mapping), last_import_at: new Date() });

    return {
      configId: config.id,
      importRef,
      ...importCounts(analysis),
      eventsStored: stored.length,
      alertsCreated: evaluation.createdAlerts.length,
      criticalAlertsCreated: criticalCreated.length,
      alertsExtended: evaluation.extendedAlertIds.size,
      stayConfirmationsRecorded: evaluation.confirmations,
      ignoredWithinGrace: evaluation.ignoredWithinGrace,
      notEvaluated: evaluation.notEvaluated,
      notifiedRecipientCount: recipients.length,
      createdAlertIds: evaluation.createdAlerts.map((a) => a.id),
      supportsRealtime: false,
    };
  });
}

// ---------------------------------------------------------------------
// Evaluation: rules → incidents and stay confirmations
// ---------------------------------------------------------------------

/**
 * Runs the rules over stored events (in occurrence order) and records the
 * outcomes. Callable with any list of stored events, so a future night-audit
 * sweep can reuse it; must run inside the caller's transaction and under the
 * property's lock_system_config row lock.
 */
async function evaluateEvents(trx, events, { graceMinutes, timeZone, importRef }) {
  const createdAlerts = [];
  const extendedAlertIds = new Set();
  let confirmations = 0;
  let ignoredWithinGrace = 0;
  let notEvaluated = 0;

  for (const event of events) {
    const result = await classifyEvent(trx, event, { graceMinutes });

    if (result.outcome === 'not_evaluated') {
      notEvaluated += 1;
    } else if (result.outcome === 'ignored_within_grace') {
      ignoredWithinGrace += 1;
    } else if (result.outcome === 'confirmation') {
      if (await recordStayConfirmation(trx, event, result.assignment)) confirmations += 1;
    } else {
      const { alert, created } = await recordIncident(trx, event, result, { graceMinutes, timeZone, importRef });
      if (created) createdAlerts.push(alert);
      else if (!createdAlerts.some((a) => String(a.id) === String(alert.id))) extendedAlertIds.add(String(alert.id));
    }
  }

  return { createdAlerts, extendedAlertIds, confirmations, ignoredWithinGrace, notEvaluated };
}

/**
 * Once per reservation. A later upload can contain an EARLIER pull of the
 * same stay; "first use" then moves to that earlier event rather than
 * keeping a later one. Returns true when a new confirmation was recorded.
 */
async function recordStayConfirmation(trx, event, assignment) {
  const existing = await trx.table('door_access_stay_confirmations').where({ reservation_id: assignment.reservation_id }).first();
  if (!existing) {
    await trx.table('door_access_stay_confirmations').insert({
      reservation_id: assignment.reservation_id,
      room_id: event.room_id,
      door_access_event_id: event.id,
      card_id: event.card_id,
      opened_at: event.opened_at,
    });
    return true;
  }
  if (new Date(event.opened_at) < new Date(existing.opened_at)) {
    await trx
      .table('door_access_stay_confirmations')
      .where({ id: existing.id })
      .update({ room_id: event.room_id, door_access_event_id: event.id, card_id: event.card_id, opened_at: event.opened_at });
  }
  return false;
}

/** PMS state frozen at detection time (§3.23: snapshot, never recompute). */
async function buildEvidence(trx, event, result, { graceMinutes, importRef }) {
  const room = await trx.table('rooms').where({ id: event.room_id }).first();
  let previousStay = null;
  if (result.closure) {
    const { reservation, assignment, endedBy } = result.closure;
    const guest = reservation ? await trx.table('guests').where({ id: reservation.guest_id }).first('first_name', 'last_name') : null;
    previousStay = {
      reservationId: reservation?.id ?? assignment.reservation_id,
      confirmationNumber: reservation?.confirmation_number ?? null,
      guestName: guest ? `${guest.first_name} ${guest.last_name}`.trim() : null,
      reservationStatus: reservation?.status ?? null,
      roomVacatedAt: assignment.effective_to,
      vacatedBy: endedBy,
    };
  }
  return {
    detectedAt: new Date(),
    importRef,
    retrospective: true,
    cardType: event.card_type,
    graceMinutes: result.rule === 'post_checkout_access' ? graceMinutes : undefined,
    roomAtDetection: room
      ? {
          roomNumber: room.room_number,
          frontDeskStatus: room.front_desk_status,
          housekeepingStatus: room.housekeeping_reported_status,
          hasDiscrepancy: Boolean(room.has_discrepancy),
        }
      : null,
    previousStay,
  };
}

/**
 * Incident key: (room, card, rule, last closed assignment). An open or
 * acknowledged incident with that key is extended; a resolved one is never
 * touched — new evidence after resolution becomes a fresh incident
 * (confirmed decision).
 */
async function recordIncident(trx, event, result, options) {
  let query = trx
    .table('access_alerts')
    .where({ room_id: event.room_id, card_id: event.card_id, rule: result.rule })
    .whereIn('status', ['open', 'acknowledged']);
  query = result.lastClosedAssignmentId === null ? query.whereNull('last_closed_assignment_id') : query.where({ last_closed_assignment_id: result.lastClosedAssignmentId });
  const existing = await query.orderBy('id', 'desc').forUpdate().first();

  const openedAt = new Date(event.opened_at);
  let alert;
  let created = false;

  if (existing) {
    await trx
      .table('access_alerts')
      .where({ id: existing.id })
      .update({
        first_event_at: openedAt < new Date(existing.first_event_at) ? openedAt : existing.first_event_at,
        last_event_at: openedAt > new Date(existing.last_event_at) ? openedAt : existing.last_event_at,
        event_count: existing.event_count + 1,
      });
    alert = existing;
  } else {
    const evidence = await buildEvidence(trx, event, result, options);
    const [id] = await trx.table('access_alerts').insert({
      room_id: event.room_id,
      card_id: event.card_id,
      rule: result.rule,
      severity: result.severity,
      reservation_id: result.reservationId,
      last_closed_assignment_id: result.lastClosedAssignmentId,
      status: 'open',
      evidence: JSON.stringify(evidence),
      business_date: calendarDateInZone(openedAt, options.timeZone),
      first_event_at: openedAt,
      last_event_at: openedAt,
      event_count: 1,
      is_retrospective: true,
    });
    alert = { id, room_id: event.room_id, rule: result.rule, severity: result.severity, first_event_at: openedAt };
    created = true;
  }

  await trx.table('access_alert_events').insert({ access_alert_id: alert.id, door_access_event_id: event.id });
  return { alert, created };
}

// ---------------------------------------------------------------------
// Notifications — manager/admin/super_admin only, never front desk or
// housekeeping (§3.23: the people with the most opportunity to commit this
// fraud must not be the ones told it was detected). The bell rows go
// through the shared `notifyStaff` writer (gap closure: staff
// notifications) so this event type is subject to the same
// `notification_role_rules` Setup-grid overrides every other staff alert
// is — a property may choose to widen or narrow who sees it. The digest
// EMAIL (below) is a separate, batched-per-import mechanism that doesn't
// fit `notifyStaff`'s one-row-per-event shape, so it keeps its own direct
// `NOTIFIED_ROLES` query rather than trying to share one.
// ---------------------------------------------------------------------

async function notifyCriticalAlerts(trx, context, { config, property, alerts, stored }) {
  const rows = await trx
    .table('user_property_access')
    .whereIn('role', NOTIFIED_ROLES)
    .joinScoped('users', (join) => join.on('user_property_access.user_id', '=', 'users.id'))
    .where('users.status', 'active')
    .select('users.id as id', 'users.email as email', 'users.first_name as first_name');
  const recipients = [...new Map(rows.map((row) => [String(row.id), row])).values()];
  if (!recipients.length) return [];

  const rooms = await trx.table('rooms').whereIn('id', [...new Set(alerts.map((a) => a.room_id))]).select('id', 'room_number');
  const roomNumberById = new Map(rooms.map((r) => [String(r.id), r.room_number]));
  const ruleLabel = { unsold_occupancy: 'unsold occupancy', post_checkout_access: 'post-checkout access' };

  // One bell row per recipient per new critical incident (not on extension —
  // re-uploading an overlapping pull must not re-ping anyone). `dedupKey`
  // is a second, belt-and-braces guard on top of that — this function is
  // only ever called with genuinely-new alerts, but a duplicate key here
  // is silently skipped rather than double-notifying anyone.
  for (const alert of alerts) {
    await notifyStaff({
      trx,
      eventType: 'door_access.critical_alert_raised',
      payload: {
        alertId: String(alert.id),
        rule: alert.rule,
        roomNumber: roomNumberById.get(String(alert.room_id)) ?? null,
        firstEventAt: alert.first_event_at,
        retrospective: true,
      },
      dedupKey: `door-access-alert-${alert.id}`,
    });
  }

  const occurred = stored.map((e) => new Date(e.opened_at)).sort((a, b) => a - b);
  const alertSummary = alerts
    .map((a) => `Room ${roomNumberById.get(String(a.room_id)) ?? '?'} — ${ruleLabel[a.rule] ?? a.rule}`)
    .join('; ');

  // One digest email per recipient per import (confirmed), through the outbox.
  for (const recipient of recipients) {
    if (!recipient.email) continue;
    await writeOutboxEvent({
      trx,
      eventType: 'door_access.critical_alerts_detected',
      aggregateType: 'lock_system_config',
      aggregateId: config.id,
      propertyId: context.propertyId,
      payload: {
        recipientEmail: recipient.email,
        recipientName: recipient.first_name,
        criticalAlertCount: alerts.length,
        alertSummary,
        importedEventCount: stored.length,
        earliestEventDate: occurred.length ? calendarDateInZone(occurred[0], property.timezone) : null,
        latestEventDate: occurred.length ? calendarDateInZone(occurred[occurred.length - 1], property.timezone) : null,
      },
    });
  }
  return recipients;
}

/**
 * Best-effort reactive dispatch once the import transaction has committed —
 * the periodic outbox sweep remains the durable fallback if Redis is down.
 */
function dispatchNotificationsSoon(context, summary) {
  if (!summary.notifiedRecipientCount) return;
  enqueueOutboxDispatch({ tenantId: context.tenantId, propertyId: context.propertyId }).catch((error) => {
    console.error('[access-monitoring] reactive outbox dispatch enqueue failed; the periodic sweep will deliver it', error);
  });
}

// ---------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------

async function listAlerts({ context, filters = {} }) {
  const db = scopedDb().for(context);
  let query = db.table('access_alerts').joinScoped('rooms', (join) => join.on('access_alerts.room_id', '=', 'rooms.id'));
  if (filters.status && ALERT_STATUSES.includes(filters.status)) query = query.where('access_alerts.status', filters.status);
  if (filters.severity) query = query.where('access_alerts.severity', filters.severity);
  if (filters.rule) query = query.where('access_alerts.rule', filters.rule);
  if (filters.roomId) query = query.where('access_alerts.room_id', filters.roomId);
  if (filters.from) query = query.where('access_alerts.business_date', '>=', filters.from);
  if (filters.to) query = query.where('access_alerts.business_date', '<=', filters.to);
  return query
    .select('access_alerts.*', 'rooms.room_number as room_number')
    .orderBy('access_alerts.first_event_at', 'desc')
    .orderBy('access_alerts.id', 'desc')
    .limit(500);
}

async function getAlert({ context, id }) {
  const db = scopedDb().for(context);
  const alert = await db
    .table('access_alerts')
    .joinScoped('rooms', (join) => join.on('access_alerts.room_id', '=', 'rooms.id'))
    .where('access_alerts.id', id)
    .first('access_alerts.*', 'rooms.room_number as room_number');
  if (!alert) return null;

  const events = await db
    .table('access_alert_events')
    .joinScoped('door_access_events', (join) => join.on('access_alert_events.door_access_event_id', '=', 'door_access_events.id'))
    .where('access_alert_events.access_alert_id', id)
    .select('door_access_events.*')
    .orderBy('door_access_events.opened_at');

  // The room's activity around the incident (±24h, any card) — §3.23's
  // "timeline of the room's activity around the event".
  const windowMs = 24 * 60 * 60 * 1000;
  const roomTimeline = await db
    .table('door_access_events')
    .where({ room_id: alert.room_id })
    .whereBetween('opened_at', [new Date(new Date(alert.first_event_at).getTime() - windowMs), new Date(new Date(alert.last_event_at).getTime() + windowMs)])
    .orderBy('opened_at')
    .limit(200);

  return { ...alert, events, roomTimeline };
}

async function transitionAlert({ context, id, to, userId, reason }) {
  if (to === 'resolved' && (typeof reason !== 'string' || reason.trim() === '')) {
    throw new ValidationError('DOOR_ACCESS_RESOLUTION_REASON_REQUIRED', 'A reason is required to resolve an alert.', [{ field: 'reason', issue: 'missing' }]);
  }
  const allowedFrom = to === 'acknowledged' ? ['open'] : ['open', 'acknowledged'];

  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    // Lock, then re-check under the lock — a plain read here could see a
    // stale snapshot and let two concurrent resolves both succeed.
    const before = await trx.table('access_alerts').where({ id }).forUpdate().first();
    if (!before) return null;
    if (!allowedFrom.includes(before.status)) throw new InvalidAlertTransitionError(id, before.status, to);

    const now = new Date();
    const changes =
      to === 'acknowledged'
        ? { status: 'acknowledged', acknowledged_at: now, acknowledged_by_user_id: userId }
        : { status: 'resolved', resolved_at: now, resolved_by_user_id: userId, resolution_reason: reason.trim() };
    await trx.table('access_alerts').where({ id }).update(changes);
    const after = await trx.table('access_alerts').where({ id }).first();
    return { before, after };
  });
}

// ---------------------------------------------------------------------
// Stay confirmations
// ---------------------------------------------------------------------

async function listStayConfirmations({ context, from, to }) {
  const db = scopedDb().for(context);
  let query = db
    .table('door_access_stay_confirmations')
    .joinScoped('rooms', (join) => join.on('door_access_stay_confirmations.room_id', '=', 'rooms.id'))
    .joinScoped('reservations', (join) => join.on('door_access_stay_confirmations.reservation_id', '=', 'reservations.id'))
    .joinScoped('guests', (join) => join.on('reservations.guest_id', '=', 'guests.id'));
  if (from) query = query.where('door_access_stay_confirmations.opened_at', '>=', from);
  if (to) query = query.where('door_access_stay_confirmations.opened_at', '<=', to);
  return query
    .select(
      'door_access_stay_confirmations.*',
      'rooms.room_number as room_number',
      'reservations.confirmation_number as confirmation_number',
      'reservations.checked_in_at as checked_in_at',
      'guests.first_name as guest_first_name',
      'guests.last_name as guest_last_name'
    )
    .orderBy('door_access_stay_confirmations.opened_at', 'desc')
    .limit(500);
}

module.exports = {
  getConfig,
  updateConfig,
  readHeaders,
  previewImport,
  commitImport,
  evaluateEvents,
  dispatchNotificationsSoon,
  listAlerts,
  getAlert,
  transitionAlert,
  listStayConfirmations,
};
