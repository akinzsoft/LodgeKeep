'use strict';

/**
 * Manager approval routes. Mounted after `authenticate('staff')` and
 * `attachAudit()`.
 *
 * Asking for an approval is open to anyone who works a till or a refund
 * screen (the cashier starts the action; the MANAGER's PIN is what is
 * checked). Each limiter caps PIN guessing on top of the per-manager lock in
 * the service: per IP, and per targeted manager.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requireAnyPermission } = require('../../auth');
const { redisRateLimiter } = require('../../shared/rate-limit');

const TILL_PERMISSIONS = ['pos.operate', 'supermarket.sales', 'supermarket.manage', 'cashiering.void_line'];
const RATE_LIMIT_MESSAGE = 'Too many approval attempts. Wait a moment and try again.';

function approvalsRouter() {
  const router = Router();

  router.get('/approvals/approvers', requireAnyPermission(TILL_PERMISSIONS), controller.listApprovers);
  router.post(
    '/approvals',
    requireAnyPermission(TILL_PERMISSIONS),
    redisRateLimiter({ windowMs: 60_000, limit: 30, prefix: 'approvals-request:ip:', message: RATE_LIMIT_MESSAGE }),
    redisRateLimiter({
      windowMs: 15 * 60_000,
      limit: 20,
      prefix: 'approvals-request:approver:',
      message: RATE_LIMIT_MESSAGE,
      // Normalised, so "05" and 5 count against the same manager.
      keyGenerator: (req) => `approver:${req.context?.tenantId ?? 'no-tenant'}:${/^\d+$/.test(String(req.body?.approver_user_id ?? '')) ? String(BigInt(req.body.approver_user_id)) : 'invalid'}`,
    }),
    controller.requestApproval
  );

  router.get('/me/approval-pin', controller.getMyApprovalPin);
  router.put(
    '/me/approval-pin',
    redisRateLimiter({ windowMs: 60_000, limit: 30, prefix: 'approvals-pin-set:ip:', message: RATE_LIMIT_MESSAGE }),
    redisRateLimiter({
      windowMs: 15 * 60_000,
      limit: 10,
      prefix: 'approvals-pin-set:acct:',
      message: RATE_LIMIT_MESSAGE,
      keyGenerator: (req) => `acct:${req.context?.tenantId ?? 'no-tenant'}:${req.context?.userId ?? 'unknown'}`,
    }),
    controller.setMyApprovalPin
  );

  return router;
}

module.exports = { approvalsRouter };
