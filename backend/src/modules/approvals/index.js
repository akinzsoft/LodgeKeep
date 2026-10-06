'use strict';

/**
 * `src/modules/approvals`' public surface — manager re-authentication (a
 * single-use, PIN-backed approval) for sensitive actions. A gated action
 * claims the request's approval inside its own transaction —
 * `claimApproval(req, trx, action, targetId)` as its first statement, or an
 * `approve` hook (`approvalConsumer(req, action, targetId)`) handed to a
 * service that claims only when the gated thing applies. New actions are
 * registered in `registry.js`.
 */

const { approvalsRouter } = require('./routes');
const { APPROVAL_ACTIONS, approvalAction } = require('./registry');
const { claimApproval, approvalConsumer, APPROVAL_HEADER } = require('./service');
const errors = require('./errors');

module.exports = {
  approvalsRouter,
  APPROVAL_ACTIONS,
  approvalAction,
  claimApproval,
  approvalConsumer,
  APPROVAL_HEADER,
  ...errors,
};
