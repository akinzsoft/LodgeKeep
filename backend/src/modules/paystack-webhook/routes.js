'use strict';

const { Router } = require('express');
const { ok, fail } = require('../../shared/response');
const { dispatchPaystackWebhook } = require('./dispatch');

function handler(defaultOwner) {
  return async (req, res, next) => {
    try {
      const { status } = await dispatchPaystackWebhook({
        rawBody: req.rawBody ?? JSON.stringify(req.body),
        signatureHeader: req.get('x-paystack-signature'),
        payload: req.body,
        defaultOwner,
      });
      // API.md §7: 200 once a genuine event is persisted; a request no key signs is refused.
      if (status === 401) return res.status(401).json(fail('AUTH_WEBHOOK_SIGNATURE_INVALID', 'Signature could not be verified.', { requestId: req.requestId }));
      return res.status(200).json(ok({ received: true }));
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Public — mounted before `authenticate('staff')` (API.md §7). The registered
 * Paystack URL is `/webhooks/paystack`; `/webhooks/billing-paystack` is a
 * backwards-compatible alias into the same dispatcher.
 */
function paystackWebhookRouter() {
  const router = Router();
  router.post('/webhooks/paystack', handler('guest'));
  router.post('/webhooks/billing-paystack', handler('billing'));
  return router;
}

module.exports = { paystackWebhookRouter };
