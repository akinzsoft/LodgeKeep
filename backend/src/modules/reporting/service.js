'use strict';

/**
 * Reporting service — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.11.
 *
 * PLAN.md Phase 2.5 closes the gap Phase 3's own header here used to flag:
 * Night Audit now exists and produces a real `daily_reports` snapshot per
 * (property, business_date), computed from the REAL `folio_line_items`
 * ledger (`src/modules/night-audit/service.js`) rather than a
 * `reservation_daily_rates` guess. `computeOccupancy`/`computeRevenue`
 * below now read that snapshot FIRST for any date night audit has already
 * closed — historically reproducible, audited figures, per-date — falling
 * back to the ORIGINAL live computation only for a date with no snapshot
 * yet (almost always the property's own current, not-yet-audited business
 * date, or any date before Night Audit's own first run). This is exactly
 * "Report figures reconcile against the underlying folio data," PLAN.md
 * Phase 3's own named test gate, finally true rather than aspirational.
 *
 * Money arithmetic goes through `src/shared/money.js` — the first place
 * this codebase has ever needed to SUM or DIVIDE money values
 * (ARCHITECTURE.md §1: "never float, anywhere").
 */

const { scopedDb } = require('../../db');
const { livePhysicalCount } = require('../../shared/room-availability');
const { sumMoney, divideMoney } = require('../../shared/money');

/** Inclusive date range as 'YYYY-MM-DD' strings — occupancy/revenue reports are inclusive of both endpoints, unlike a stay's arrival-inclusive/departure-exclusive convention. */
function inclusiveDateRange(dateFrom, dateTo) {
  const dates = [];
  const cursor = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** A reservation that never actually held or used inventory for real — excluded from both occupancy and revenue. */
const NON_REVENUE_STATUSES = ['cancelled', 'no_show', 'waitlisted'];

/**
 * Per-day occupancy: total rooms sold (across every room type,
 * `room_type_inventory.rooms_sold`) against the property-wide live physical
 * count (`src/shared/room-availability.js` — already excludes out-of-order
 * and discrepant rooms).
 */
/** One `daily_reports` row per business_date already audited in this range — the source of truth for a CLOSED date (see file header). */
async function auditedReportsByDate({ db, dateFrom, dateTo }) {
  const rows = await db.table('daily_reports').whereBetween('business_date', [dateFrom, dateTo]);
  return new Map(rows.map((row) => [String(row.business_date), row]));
}

async function computeOccupancy({ context, dateFrom, dateTo }) {
  const db = scopedDb().for(context);
  const dates = inclusiveDateRange(dateFrom, dateTo);
  const audited = await auditedReportsByDate({ db, dateFrom, dateTo });

  const inventoryRows = await db.table('room_type_inventory').whereBetween('stay_date', [dateFrom, dateTo]);
  const soldByDate = new Map();
  for (const row of inventoryRows) {
    const key = String(row.stay_date);
    soldByDate.set(key, (soldByDate.get(key) ?? 0) + row.rooms_sold);
  }

  const days = [];
  for (const date of dates) {
    const auditedReport = audited.get(date);
    if (auditedReport) {
      days.push({
        date,
        physicalCount: null, // Not carried on the snapshot — the audited occupancyPct is the reproduced figure itself.
        roomsSold: soldByDate.get(date) ?? 0,
        occupancyPct: Number(auditedReport.occupancy_pct),
        audited: true,
      });
      continue;
    }
    const physicalCount = await livePhysicalCount({ db, stayDate: date });
    const roomsSold = soldByDate.get(date) ?? 0;
    const occupancyPct = physicalCount > 0 ? Number(((roomsSold / physicalCount) * 100).toFixed(2)) : 0;
    days.push({ date, physicalCount, roomsSold, occupancyPct, audited: false });
  }
  return days;
}

/**
 * Per-day room revenue, ADR (revenue / rooms sold), and RevPAR (revenue /
 * rooms available) — `reports.view_financial` only (SECURITY.md §5's
 * matrix: manager/admin/super_admin, not the "Limited" front_desk/cashier
 * cell, which gets `reports.view`'s occupancy figures only).
 */
async function computeRevenue({ context, dateFrom, dateTo }) {
  const db = scopedDb().for(context);
  const dates = inclusiveDateRange(dateFrom, dateTo);
  const audited = await auditedReportsByDate({ db, dateFrom, dateTo });

  const rateRows = await db
    .table('reservation_daily_rates')
    .joinScoped('reservations', (join) => join.on('reservation_daily_rates.reservation_id', '=', 'reservations.id'))
    .whereBetween('reservation_daily_rates.stay_date', [dateFrom, dateTo])
    .whereNotIn('reservations.status', NON_REVENUE_STATUSES)
    .select('reservation_daily_rates.stay_date as stay_date', 'reservation_daily_rates.rate as rate');

  const ratesByDate = new Map();
  for (const row of rateRows) {
    const key = String(row.stay_date);
    if (!ratesByDate.has(key)) ratesByDate.set(key, []);
    ratesByDate.get(key).push(row.rate);
  }

  const days = [];
  for (const date of dates) {
    const auditedReport = audited.get(date);
    if (auditedReport) {
      days.push({
        date,
        roomRevenue: auditedReport.room_revenue,
        roomsSold: (ratesByDate.get(date) ?? []).length,
        adr: auditedReport.adr,
        revpar: auditedReport.revpar,
        paymentsCollected: auditedReport.payments_collected,
        audited: true,
      });
      continue;
    }
    const physicalCount = await livePhysicalCount({ db, stayDate: date });
    const rates = ratesByDate.get(date) ?? [];
    const roomRevenue = sumMoney(rates);
    days.push({
      date,
      roomRevenue,
      roomsSold: rates.length,
      adr: divideMoney(roomRevenue, rates.length),
      revpar: divideMoney(roomRevenue, physicalCount),
      audited: false,
    });
  }
  return days;
}

/**
 * Housekeeping's own report figures for one business date — discrepancy
 * counts and assignment completion, the two things PLAN.md Phase 3's
 * Housekeeping bullet ("discrepancy detection and report") and the manager
 * dashboard's alert strip both need.
 */
async function computeHousekeepingSummary({ context, businessDate }) {
  const db = scopedDb().for(context);
  const [openDiscrepancies, resolvedDiscrepancies, assignments] = await Promise.all([
    db.table('housekeeping_discrepancies').where({ business_date: businessDate }).whereNull('resolved_at').count(),
    db.table('housekeeping_discrepancies').where({ business_date: businessDate }).whereNotNull('resolved_at').count(),
    db.table('housekeeping_assignments').where({ business_date: businessDate }),
  ]);

  const byStatus = { assigned: 0, in_progress: 0, completed: 0 };
  for (const assignment of assignments) {
    byStatus[assignment.status] = (byStatus[assignment.status] ?? 0) + 1;
  }

  return { businessDate, openDiscrepancies, resolvedDiscrepancies, assignments: byStatus };
}

/**
 * Tonight's oversell position across every room type — feeds the manager
 * dashboard alert strip's "oversold room types tonight" (PRODUCT_REQUIREMENTS.md
 * Manager dashboard section) by reusing the same threshold math
 * `checkAvailability` uses, one room type at a time, for a single date.
 */
async function computeOversoldRoomTypes({ context, businessDate }) {
  const db = scopedDb().for(context);
  const roomTypes = await db.table('room_types').where({ status: 'active' });

  const oversold = [];
  for (const roomType of roomTypes) {
    const physicalCount = await livePhysicalCount({ db, roomTypeId: roomType.id, stayDate: businessDate });
    const row = await db
      .table('room_type_inventory')
      .where({ room_type_id: roomType.id, stay_date: businessDate })
      .first();
    const thresholdPct = row ? Number(row.overbooking_threshold_pct) : 100;
    const roomsSold = row ? row.rooms_sold : 0;
    const threshold = Math.floor((physicalCount * thresholdPct) / 100);
    if (roomsSold > threshold) {
      oversold.push({ roomTypeId: roomType.id, roomTypeCode: roomType.code, roomsSold, threshold, physicalCount });
    }
  }
  return oversold;
}

/** CSV export (PRODUCT_REQUIREMENTS.md §3.11: "export must reflect the filters currently applied on screen") — no PDF/Excel library exists yet in this codebase; CSV needs none. */
function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows
    .map((row) => columns.map((column) => String(row[column] ?? '')).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

module.exports = {
  inclusiveDateRange,
  computeOccupancy,
  computeRevenue,
  computeHousekeepingSummary,
  computeOversoldRoomTypes,
  toCsv,
};
