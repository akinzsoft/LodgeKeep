'use strict';

const { ok } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

async function getOverview(req, res, next) {
  try {
    res.status(200).json(ok(await service.getBillingOverview({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function listPlans(req, res, next) {
  try {
    res.status(200).json(ok(await service.listPlans()));
  } catch (error) {
    next(error);
  }
}

async function listInvoices(req, res, next) {
  try {
    res.status(200).json(ok(await service.listInvoices({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function listPaymentsForInvoice(req, res, next) {
  try {
    res.status(200).json(ok(await service.listPaymentsForInvoice({ context: req.context, invoiceId: req.params.invoiceId })));
  } catch (error) {
    next(error);
  }
}

async function startAddPaymentMethod(req, res, next) {
  try {
    const email = require_(req.body, 'email');
    const result = await service.startAddPaymentMethodCheckout({ context: req.context, email, callbackUrl: req.body?.callback_url });
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function completeAddPaymentMethod(req, res, next) {
  try {
    const reference = require_(req.body, 'reference');
    const result = await service.completeAddPaymentMethod({
      context: req.context,
      reference,
      requestId: req.requestId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getOverview,
  listPlans,
  listInvoices,
  listPaymentsForInvoice,
  startAddPaymentMethod,
  completeAddPaymentMethod,
};
