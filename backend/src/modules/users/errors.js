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

/** Changing or deactivating a user whose role ranks above the actor's (or moving someone above the actor's own rank). */
class UserRankError extends AppError {
  constructor(message) {
    super('FORBIDDEN_ROLE_ESCALATION', message, 403);
  }
}

class SelfRoleChangeError extends AppError {
  constructor() {
    super('FORBIDDEN_SELF_ROLE_CHANGE', 'You cannot change your own role. Ask another administrator.', 403);
  }
}

class SelfDeactivationError extends AppError {
  constructor() {
    super('FORBIDDEN_SELF_DEACTIVATION', 'You cannot deactivate your own account. Ask another administrator.', 403);
  }
}

/** The tenant must always keep at least one active super_admin, whichever property they hold the role at. */
class LastSuperAdminError extends AppError {
  constructor() {
    super('FORBIDDEN_LAST_SUPER_ADMIN', 'This is the last active super admin of the organisation, so their role or account cannot be removed. Make another super admin first.', 403);
  }
}

module.exports = { UserRankError, SelfRoleChangeError, SelfDeactivationError, LastSuperAdminError, RoleEscalationError, InvitationNotPendingError, InvitationResendLimitError };
