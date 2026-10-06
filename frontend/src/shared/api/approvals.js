import { request } from './client.js';

/**
 * Manager approvals (backend `src/modules/approvals`): a manager's PIN at the
 * till for one sensitive action. `requestApproval` returns a single-use token
 * (2 minutes) that the action sends in the `X-Manager-Approval` header —
 * never the body. `approvalHeaders` builds that header for the api wrappers.
 */

export const APPROVAL_HEADER = 'X-Manager-Approval';

/** `{X-Manager-Approval: token}`, or nothing when there is no token. */
export function approvalHeaders(approval) {
  return approval ? { [APPROVAL_HEADER]: approval } : {};
}

/** Who may approve `action` here: `[{id, name, hasPin}]`. */
export function listApprovers(action) {
  return request(`/approvals/approvers?action=${encodeURIComponent(action)}`);
}

/** Checks the manager's PIN; resolves to `{token, expires_at, approval_id, approver: {id, name}}`. */
export function requestApproval({ action, approverUserId, pin, reason, targetId }) {
  return request('/approvals', {
    method: 'POST',
    body: { action, approver_user_id: approverUserId, pin, reason, target_id: targetId ?? undefined },
  });
}

/** `{has_pin, set_at, locked_until}` for the signed-in user. */
export function getMyApprovalPin() {
  return request('/me/approval-pin');
}

export function setMyApprovalPin({ currentPassword, pin }) {
  return request('/me/approval-pin', { method: 'PUT', body: { current_password: currentPassword, pin } });
}
