'use strict';

/**
 * Supermarket online (Paystack) sales — see `paystack-sale.js`. Starting a
 * sale is two halves, like the Register's card checkout: the local half
 * (price the cart, write the pending sale and its payment) under the
 * request's Idempotency-Key, then the Paystack call outside any transaction.
 * A Paystack failure there is a `202` with `checkoutError` — the pending sale
 * exists and `POST .../checkout` retries it.
 */

const { ok } = require('../../shared/response');
const { requireIdempotencyKey } = require('../../shared/mutation');
const { withIdempotency } = require('../../shared/idempotency');
const { ValidationError } = require('../../shared/errors');
const online = require('./paystack-sale');

async function startOnlineSale(req, res, next) {
  try {
    const key = requireIdempotencyKey(req);
    const outcome = await withIdempotency({
      context: req.context,
      operationType: 'supermarket.start_online_sale',
      key,
      payload: req.body ?? {},
      handler: async (trx) => {
        const intent = await online.startOnlineSale({
          trx,
          context: req.context,
          userId: req.context.userId,
          outletId: req.body?.outlet_id,
          lines: req.body?.items,
          tender: req.body?.tender,
          confirmOversell: req.body?.confirm_oversell === true,
          customerEmail: req.body?.customer_email,
          idempotencyKey: key,
        });
        return { status: 201, body: ok(intent) };
      },
    });
    const intent = outcome.body.data;
    if (!outcome.replayed) {
      await req.audit({ entityType: 'supermarket_sale_intents', entityId: intent.id, action: 'start_online_sale', afterState: intent });
    }
    await respondWithCheckout(req, res, intent);
  } catch (error) {
    next(error);
  }
}

async function respondWithCheckout(req, res, intent) {
  try {
    const checkout = await online.startOnlineCheckout({ context: req.context, intentId: intent.id });
    res.status(201).json(ok(checkout.intent, { accessCode: checkout.accessCode, checkoutUrl: checkout.checkoutUrl, qrDataUrl: checkout.qrDataUrl }));
  } catch (checkoutError) {
    res.status(202).json(ok(intent, { checkoutError: checkoutError.message }));
  }
}

async function reopenCheckout(req, res, next) {
  try {
    const intent = await online.getOnlineSale({ context: req.context, intentId: req.params.id });
    await respondWithCheckout(req, res, intent);
  } catch (error) {
    next(error);
  }
}

async function getOnlineSale(req, res, next) {
  try {
    res.json(ok(await online.getOnlineSale({ context: req.context, intentId: req.params.id })));
  } catch (error) {
    next(error);
  }
}

async function myPending(req, res, next) {
  try {
    if (!req.query.outlet_id) throw new ValidationError('MISSING_FIELD', '"outlet_id" is required.', [{ field: 'outlet_id', issue: 'missing' }]);
    res.json(ok(await online.getMyPendingOnlineSale({ context: req.context, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function needingReview(req, res, next) {
  try {
    res.json(ok(await online.listOnlineSalesNeedingReview({ context: req.context, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function check(req, res, next) {
  try {
    const view = await online.checkOnlineSale({ context: req.context, intentId: req.params.id, userId: req.context.userId });
    const { checkError, ...intent } = view;
    res.json(ok(intent, checkError ? { checkError } : {}));
  } catch (error) {
    next(error);
  }
}

async function cancel(req, res, next) {
  try {
    const intent = await online.cancelOnlineSale({ context: req.context, intentId: req.params.id, userId: req.context.userId, reason: req.body?.reason });
    await req.audit({ entityType: 'supermarket_sale_intents', entityId: intent.id, action: 'cancel_online_sale_request', afterState: { status: intent.status } });
    res.json(ok(intent));
  } catch (error) {
    next(error);
  }
}

async function refund(req, res, next) {
  try {
    const key = requireIdempotencyKey(req);
    const result = await online.refundOnlinePayment({ context: req.context, intentId: req.params.id, reason: req.body?.reason, userId: req.context.userId, idempotencyKey: key });
    await req.audit({ entityType: 'supermarket_sale_intents', entityId: req.params.id, action: 'refund_online_payment', afterState: { refundPaymentId: result.refund.id, refundStatus: result.refund.status }, reason: req.body?.reason });
    res.json(ok(result.intent, { refund: result.refund }));
  } catch (error) {
    next(error);
  }
}

module.exports = { startOnlineSale, reopenCheckout, getOnlineSale, myPending, needingReview, check, cancel, refund };
