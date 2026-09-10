'use strict';

/**
 * HTTP layer for Accounts Receivable — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`. Every mutation goes through `runIdempotentMutation`,
 * matching every other financial mutation in this codebase
 * (ARCHITECTURE.md §7) — including the two account-configuration
 * mutations (create/update), since a credit-limit or enforcement-mode
 * change is itself a real business-sensitive action, not a routine
 * reference-data edit.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { runIdempotentMutation } = require('../../shared/mutation');
// `toCsv` is the reporting module's own generic `(rows, columns) => string`
// — no dependency the other way — the same cross-module reuse
// `reservations/controller.js`'s own outstanding-balances CSV export
// already established.
const { toCsv } = require('../reporting/service');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

/** `[{ invoice_id, amount }]` over the wire -> `[{ invoiceId, amount }]` for `service.js`'s `applyPaymentApplications`. */
function normalizeApplications(applications) {
  if (!Array.isArray(applications)) return applications;
  return applications.map((application) => ({ invoiceId: application.invoice_id, amount: application.amount }));
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

/** Allowlist — mirrors `pickRoomTypeChanges`/`pickPropertyChanges` (setup/controller.js) and `pickCompanyProfileChanges` (profiles/controller.js). */
function pickArAccountChanges(body) {
  const changes = {};
  if (body?.credit_limit !== undefined) changes.credit_limit = body.credit_limit;
  if (body?.enforcement_mode !== undefined) changes.enforcement_mode = body.enforcement_mode;
  if (body?.status !== undefined) changes.status = body.status;
  return changes;
}

async function createAccount(req, res, next) {
  try {
    const companyProfileId = require_(req.body, 'company_profile_id');
    const currency = require_(req.body, 'currency');
    await runIdempotentMutation(req, res, {
      operationType: 'ar.create_account',
      entityType: 'ar_accounts',
      action: 'create',
      handler: async (trx) => {
        const account = await service.createArAccount({
          trx,
          companyProfileId,
          creditLimit: req.body?.credit_limit,
          currency,
          enforcementMode: req.body?.enforcement_mode,
        });
        return { status: 201, body: ok(account) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function updateAccount(req, res, next) {
  try {
    const before = await service.getAccount({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    await runIdempotentMutation(req, res, {
      operationType: 'ar.update_account',
      entityType: 'ar_accounts',
      entityId: req.params.id,
      action: 'update',
      handler: async (trx) => {
        const account = await service.updateArAccount({ trx, id: req.params.id, changes: pickArAccountChanges(req.body) });
        return { status: 200, body: ok(account) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getAccount(req, res, next) {
  try {
    const account = await service.getAccount({ context: req.context, id: req.params.id });
    if (!account) return notFound(res);
    res.status(200).json(ok(account));
  } catch (error) {
    next(error);
  }
}

async function listAccounts(req, res, next) {
  try {
    res.status(200).json(ok(await service.listAccounts({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Invoices — TESTING.md AR-1
// ---------------------------------------------------------------------

async function generateInvoice(req, res, next) {
  try {
    const account = await service.getAccount({ context: req.context, id: req.params.id });
    if (!account) return notFound(res);
    await runIdempotentMutation(req, res, {
      operationType: 'ar.generate_invoice',
      entityType: 'ar_invoices',
      action: 'generate',
      handler: async (trx) => {
        const invoice = await service.generateInvoice({ trx, arAccountId: req.params.id, userId: req.context.userId });
        return { status: 201, body: ok(invoice) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function listInvoicesForAccount(req, res, next) {
  try {
    res.status(200).json(ok(await service.listInvoicesForAccount({ context: req.context, arAccountId: req.params.id })));
  } catch (error) {
    next(error);
  }
}

async function getInvoice(req, res, next) {
  try {
    const invoice = await service.getInvoice({ context: req.context, id: req.params.id });
    if (!invoice) return notFound(res);
    res.status(200).json(ok(invoice));
  } catch (error) {
    next(error);
  }
}

async function voidInvoice(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'ar.void_invoice',
      entityType: 'ar_invoices',
      entityId: req.params.id,
      action: 'void',
      handler: async (trx) => {
        const invoice = await service.voidInvoice({ trx, invoiceId: req.params.id, reason, userId: req.context.userId });
        return { status: 200, body: ok(invoice) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Payments — manual recording only
// ---------------------------------------------------------------------

async function recordPayment(req, res, next) {
  try {
    const amount = require_(req.body, 'amount');
    const currency = require_(req.body, 'currency');
    const methodLabel = require_(req.body, 'method_label');
    const receivedAt = require_(req.body, 'received_at');
    await runIdempotentMutation(req, res, {
      operationType: 'ar.record_payment',
      entityType: 'ar_payments',
      action: 'record',
      handler: async (trx) => {
        const payment = await service.recordPayment({
          trx,
          arAccountId: req.params.id,
          amount,
          currency,
          methodLabel,
          reference: req.body?.reference,
          receivedAt,
          businessDate: req.body?.business_date,
          applications: normalizeApplications(req.body?.applications),
          userId: req.context.userId,
        });
        return { status: 201, body: ok(payment) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function listPaymentsForAccount(req, res, next) {
  try {
    res.status(200).json(ok(await service.listPaymentsForAccount({ context: req.context, arAccountId: req.params.id })));
  } catch (error) {
    next(error);
  }
}

async function applyPayment(req, res, next) {
  try {
    const applications = normalizeApplications(require_(req.body, 'applications'));
    await runIdempotentMutation(req, res, {
      operationType: 'ar.apply_payment',
      entityType: 'ar_payments',
      entityId: req.params.id,
      action: 'apply',
      handler: async (trx) => {
        const payment = await service.applyPayment({ trx, paymentId: req.params.id, applications });
        return { status: 200, body: ok(payment) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function voidPayment(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'ar.void_payment',
      entityType: 'ar_payments',
      entityId: req.params.id,
      action: 'void',
      handler: async (trx) => {
        const payment = await service.voidPayment({ trx, paymentId: req.params.id, reason, userId: req.context.userId });
        return { status: 200, body: ok(payment) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Ageing report — TESTING.md AR-2
// ---------------------------------------------------------------------

const AGEING_CSV_COLUMNS = [
  'companyName',
  'currentBalance',
  'creditLimit',
  'current',
  'bucket_1_30',
  'bucket_31_60',
  'bucket_61_90',
  'bucket_90_plus',
];

async function getAgeingReport(req, res, next) {
  try {
    const report = await service.computeAgeingReport({ context: req.context });
    if (req.query?.format === 'csv') {
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', 'attachment; filename="ar-ageing.csv"')
        .send(toCsv(report.rows, AGEING_CSV_COLUMNS));
      return;
    }
    res.status(200).json(ok(report.rows, { asOfDate: report.asOfDate, total: report.total }));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createAccount,
  updateAccount,
  getAccount,
  listAccounts,
  generateInvoice,
  listInvoicesForAccount,
  getInvoice,
  voidInvoice,
  recordPayment,
  listPaymentsForAccount,
  applyPayment,
  voidPayment,
  getAgeingReport,
};
