'use strict';

const { ok } = require('../../shared/response');
const service = require('./service');

/** GET /approvals/approvers?action= — who may approve this action here (ids and names). */
async function listApprovers(req, res, next) {
  try {
    res.json(ok(await service.listApprovers(req.context, req.query.action)));
  } catch (error) {
    next(error);
  }
}

/** POST /approvals — a manager's PIN for one action on one record; returns the single-use token. */
async function requestApproval(req, res, next) {
  try {
    const result = await service.requestApproval(req.context, {
      action: req.body?.action,
      approverUserId: req.body?.approver_user_id,
      pin: req.body?.pin,
      reason: req.body?.reason,
      targetId: req.body?.target_id,
      meta: service.requestMeta(req),
    });
    res.status(201).json(ok({ token: result.token, expires_at: result.expiresAt, approval_id: result.approvalId, approver: result.approver }));
  } catch (error) {
    next(error);
  }
}

/** GET /me/approval-pin — whether the signed-in user has set a PIN (never the PIN). */
async function getMyApprovalPin(req, res, next) {
  try {
    const result = await service.getMyApprovalPin(req.context);
    res.json(ok({ has_pin: result.hasPin, set_at: result.setAt, locked_until: result.lockedUntil }));
  } catch (error) {
    next(error);
  }
}

/** PUT /me/approval-pin — set or change one's own PIN, re-entering the password. */
async function setMyApprovalPin(req, res, next) {
  try {
    const result = await service.setApprovalPin(req.context, {
      currentPassword: req.body?.current_password,
      pin: req.body?.pin,
      meta: service.requestMeta(req),
    });
    res.json(ok({ has_pin: result.hasPin, set_at: result.setAt }));
  } catch (error) {
    next(error);
  }
}

module.exports = { listApprovers, requestApproval, getMyApprovalPin, setMyApprovalPin };
