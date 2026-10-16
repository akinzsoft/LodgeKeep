'use strict';

const { AppError } = require('../../shared/errors');

/** The caller's role ranks below the role being invited, resent or revoked. */
class RoleEscalationError extends AppError {
  constructor(role) {
    super('FORBIDDEN_ROLE_ESCALATION', `You cannot manage an invitation for the "${role}" role: it ranks above your own role.`, 403);
  }
}

/** Only pending or expired invitations can be resent or revoked. */
class InvitationNotPendingError extends AppError {
  constructor(state) {
    super('CONFLICT_INVITATION_NOT_PENDING', `This invitation was already ${state}, so it cannot be changed.`, 409);
  }
}

/** Too many resends for one invitation. */
class InvitationResendLimitError extends AppError {
  constructor(message) {
    super('RATE_LIMITED_INVITATION_RESEND', message, 429);
  }
}

module.exports = { RoleEscalationError, InvitationNotPendingError, InvitationResendLimitError };
