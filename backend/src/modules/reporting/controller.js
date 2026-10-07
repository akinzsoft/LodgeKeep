'use strict';

/**
 * HTTP layer for the reporting module — parses the request, calls the
 * service, shapes the API.md §2 envelope (or a CSV body — see `sendReport`).
 * No business logic here; see `service.js`.
 *
 * Allow-listed query params only (API.md's own rule): `date_from`, `date_to`,
 * `format` ('json', the default, or 'csv').
 */

const { ok } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');
const businessSummary = require('./business-summary');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function require_(query, field) {
  const value = query?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

/** Sends either the JSON envelope or a CSV attachment, reflecting whatever filters the caller already applied (PRODUCT_REQUIREMENTS.md §3.11's own export requirement) — never a silent unfiltered dump. */
function sendReport(req, res, { rows, columns, filename }) {
  if (req.query?.format === 'csv') {
    res.status(200).set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="${filename}"`).send(service.toCsv(rows, columns));
    return;
  }
  res.status(200).json(ok(rows));
}

async function occupancy(req, res, next) {
  try {
    const dateFrom = require_(req.query, 'date_from');
    const dateTo = require_(req.query, 'date_to');
    const rows = await service.computeOccupancy({ context: req.context, dateFrom, dateTo });
    sendReport(req, res, { rows, columns: ['date', 'physicalCount', 'roomsSold', 'occupancyPct'], filename: `occupancy-${dateFrom}-to-${dateTo}.csv` });
  } catch (error) {
    next(error);
  }
}

async function revenue(req, res, next) {
  try {
    const dateFrom = require_(req.query, 'date_from');
    const dateTo = require_(req.query, 'date_to');
    const rows = await service.computeRevenue({ context: req.context, dateFrom, dateTo });
    sendReport(req, res, { rows, columns: ['date', 'roomRevenue', 'roomsSold', 'adr', 'revpar'], filename: `revenue-${dateFrom}-to-${dateTo}.csv` });
  } catch (error) {
    next(error);
  }
}

async function housekeepingSummary(req, res, next) {
  try {
    const businessDate = require_(req.query, 'business_date');
    const summary = await service.computeHousekeepingSummary({ context: req.context, businessDate });
    res.status(200).json(ok(summary));
  } catch (error) {
    next(error);
  }
}

async function oversoldRoomTypes(req, res, next) {
  try {
    const businessDate = require_(req.query, 'business_date');
    const rows = await service.computeOversoldRoomTypes({ context: req.context, businessDate });
    res.status(200).json(ok(rows));
  } catch (error) {
    next(error);
  }
}

/**
 * PLAN.md Phase 6's Multi-Property Roll-Up. CSV export covers only the
 * per-property `properties` breakdown, not `totals` — a blended-currency
 * total has no honest single CSV row shape.
 */
async function chainOverview(req, res, next) {
  try {
    const result = await service.computeChainOverview({ context: req.context });
    if (req.query?.format === 'csv') {
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', 'attachment; filename="chain-overview.csv"')
        .send(
          service.toCsv(result.properties, [
            'propertyId',
            'propertyName',
            'currencyCode',
            'businessDate',
            'occupancyPct',
            'roomsSold',
            'roomRevenue',
            'audited',
          ])
        );
      return;
    }
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** `GET /reports/business-summary?date_from&date_to[&format=csv]` — see `business-summary.js` for the revenue basis. */
async function businessSummaryReport(req, res, next) {
  try {
    const dateFrom = req.query?.date_from;
    const dateTo = req.query?.date_to;
    if (!ISO_DATE.test(dateFrom ?? '') || !ISO_DATE.test(dateTo ?? '')) {
      throw new ValidationError('INVALID_DATE_RANGE', '"date_from" and "date_to" are required, as YYYY-MM-DD.', [{ field: 'date_from', issue: 'invalid' }]);
    }
    if (dateFrom > dateTo) {
      throw new ValidationError('INVALID_DATE_RANGE', '"date_from" must not be after "date_to".', [{ field: 'date_from', issue: 'after_date_to' }]);
    }
    const summary = await businessSummary.computeBusinessSummary({ context: req.context, dateFrom, dateTo });
    if (req.query?.format === 'csv') {
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', `attachment; filename="business-summary-${dateFrom}-to-${dateTo}.csv"`)
        .send(service.toCsv(businessSummary.toCsvRows(summary), businessSummary.CSV_COLUMNS));
      return;
    }
    res.status(200).json(ok(summary));
  } catch (error) {
    next(error);
  }
}

module.exports = { occupancy, revenue, housekeepingSummary, oversoldRoomTypes, chainOverview, businessSummaryReport };
