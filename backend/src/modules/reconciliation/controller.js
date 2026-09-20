'use strict';

/**
 * HTTP layer for the payment reconciliation report. No business logic
 * here; see `service.js`. Mirrors `pos/controller.js`'s `salesReport`
 * handler exactly — the closest existing precedent for a date-ranged
 * money report with a `?format=csv` variant.
 */

const { ok } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { toCsv } = require('../reporting/service');
const { computePaymentReconciliation, CSV_COLUMNS, toCsvRows } = require('./service');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `GET /reconciliation/payments?date_from&date_to[&format=csv]`. Allow-listed query params only. */
async function paymentsReport(req, res, next) {
  try {
    const dateFrom = req.query?.date_from;
    const dateTo = req.query?.date_to;
    if (!ISO_DATE.test(dateFrom ?? '') || !ISO_DATE.test(dateTo ?? '')) {
      throw new ValidationError('INVALID_DATE_RANGE', '"date_from" and "date_to" are required, as YYYY-MM-DD.', [{ field: 'date_from', issue: 'invalid' }]);
    }
    if (dateFrom > dateTo) {
      throw new ValidationError('INVALID_DATE_RANGE', '"date_from" must not be after "date_to".', [{ field: 'date_from', issue: 'after_date_to' }]);
    }

    const report = await computePaymentReconciliation({ context: req.context, dateFrom, dateTo });

    if (req.query?.format === 'csv') {
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', `attachment; filename="payment-reconciliation-${dateFrom}-to-${dateTo}.csv"`)
        .send(toCsv(toCsvRows(report.lines), CSV_COLUMNS));
      return;
    }
    res.status(200).json(ok(report));
  } catch (error) {
    next(error);
  }
}

module.exports = { paymentsReport };
