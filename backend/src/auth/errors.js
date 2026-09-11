'use strict';

/**
 * Auth-specific error types — API.md §3's namespaced codes, scoped to what
 * `src/auth` raises. Extends the base `AppError` in `src/shared/errors.js`
 * rather than duplicating its shape.
 */

const { AppError, ValidationError, DuplicateEntryError } = require('../shared/errors');

/**
 * Wrong password, or an email that resolved to no account. TESTING.md AUTH-2
 * requires these two cases to be indistinguishable to the caller — this is the
 * one error type both paths throw, with the one generic message.
 */
class InvalidCredentialsError extends AppError {
  constructor() {
    super('AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
  }
}

/** TESTING.md AUTH-3/AUTH-4 — API.md §3's LOCKED_ prefix, 423. */
class AccountLockedError extends AppError {
  constructor(dimension) {
    super('LOCKED_ACCOUNT', 'Too many attempts. Try again later.', 423, { dimension });
  }
}

/** An expired access token — TESTING.md AUTH-5. Distinct from a bad opaque token below. */
class TokenExpiredError extends AppError {
  constructor() {
    super('AUTH_TOKEN_EXPIRED', 'This session has expired. Please log in again.', 401);
  }
}

/**
 * A malformed/unsigned access token, or an opaque refresh/reset/invitation
 * token that does not resolve, is expired, already used, or revoked
 * (TESTING.md AUTH-6, AUTH-7). One code for all of these: from the caller's
 * side they are the same fact — "this credential no longer works" — and the
 * true reason is recorded server-side in `auth_events.failure_reason`, not
 * returned (mirrors AUTH-2's anti-enumeration reasoning).
 */
class TokenInvalidError extends AppError {
  constructor(message = 'This link or session is no longer valid.') {
    super('AUTH_TOKEN_INVALID', message, 401);
  }
}

/** API.md §4 — a token minted for one audience presented to another's routes. */
class WrongAudienceError extends AppError {
  constructor() {
    super('AUTH_WRONG_AUDIENCE', 'This credential is not valid for this API.', 401);
  }
}

/** No bearer token at all on a route that is not on the public allow-list (AUTH-15). */
class UnauthenticatedError extends AppError {
  constructor() {
    super('AUTH_UNAUTHENTICATED', 'Authentication is required.', 401);
  }
}

/**
 * The account behind a still-valid, still-unexpired access token was
 * deactivated (or its guest/platform equivalent suspended) since the token
 * was issued — TESTING.md AUTH-10. Distinct from `TokenExpiredError`: the
 * token itself is fine, what changed is the account it names, which is why
 * `authenticate` middleware re-checks status against the database on every
 * request rather than trusting this claim for the token's full lifetime.
 */
class SessionInvalidError extends AppError {
  constructor() {
    super('AUTH_SESSION_INVALID', 'Your session is no longer valid. Please log in again.', 401);
  }
}

/**
 * `POST /auth/mfa/verify` exists so the shape is fixed. Originally returned
 * unconditionally for both audiences before either had real verification.
 * The STAFF path stopped hitting this once a gap closure (user-reported)
 * replaced the old fixed dev-only bypass code with a real, emailed 6-digit
 * code (a genuinely wrong/expired/already-used code for a valid staff
 * challenge gets `MfaCodeInvalidError` below instead) — it now survives
 * only as the fallback for a garbage/expired/wrong-audience STAFF
 * challenge TOKEN (`verifyStaffMfa`'s own `catch`). PLAN.md Phase 5
 * (Platform Foundation) closes the platform half too — real TOTP now
 * exists (`src/auth/totp.js`), so a platform MFA-verify attempt no longer
 * reaches this at all; a garbage/expired/wrong-audience platform challenge
 * or enrollment token gets `TokenInvalidError` from its own real endpoint
 * instead. 501, not 500: this remains a known, narrow gap (one staff edge
 * case) in what the API offers, not a server fault.
 */
class MfaNotImplementedError extends AppError {
  constructor() {
    super('AUTH_MFA_NOT_IMPLEMENTED', 'MFA verification is not yet available.', 501);
  }
}

/**
 * Gap closure (user-reported, live-tested): the real rejection for a
 * staff MFA code that is wrong, expired, already used, or has exceeded
 * `MFA_CODE_MAX_ATTEMPTS` (`src/auth/mfa.js`) — the STAFF counterpart to
 * `MfaNotImplementedError` now that real verification exists for that
 * path. One code for all of these, matching `TokenInvalidError`'s own
 * "the true reason is recorded server-side in auth_events.failure_reason,
 * not returned" reasoning — a caller learns only "this code did not work",
 * never which specific case applied.
 */
class MfaCodeInvalidError extends AppError {
  constructor() {
    super('AUTH_MFA_CODE_INVALID', 'That verification code is incorrect or has expired.', 401);
  }
}

/**
 * SECURITY.md §3: "every request that touches property-scoped data is
 * verified server-side against user_property_access for the currently active
 * property." An RBAC check has no property to check a grant at — the caller
 * has not switched to one yet, not a caller with no permission.
 */
class NoActivePropertyError extends AppError {
  constructor() {
    super(
      'FORBIDDEN_NO_ACTIVE_PROPERTY',
      'Select an active property before performing this action.',
      403
    );
  }
}

/**
 * SECURITY.md §5: "every endpoint is checked against this matrix, not against
 * role name alone." The caller is authenticated and holds a role at the
 * active property, but that role has not been granted the specific permission
 * the endpoint requires.
 */
class PermissionDeniedError extends AppError {
  constructor(permissionKey, role) {
    super(
      'FORBIDDEN_PERMISSION',
      'You do not have permission to perform this action.',
      403,
      { permission: permissionKey, role }
    );
  }
}

/**
 * PLAN.md Phase 5 (Platform Foundation), API.md §4: "every route that
 * touches tenant data via impersonation requires an active grant, checked
 * per request, not just at token issuance." A `staff_impersonation` token
 * whose `impersonation_sessions` row has been explicitly ended, or whose
 * `expires_at` has lapsed, fails this re-check on the very next request —
 * distinct from `TokenExpiredError` (the JWT itself, still cryptographically
 * valid) exactly the way `SessionInvalidError` is distinct from it for an
 * ordinary staff session.
 */
class ImpersonationEndedError extends AppError {
  constructor() {
    super('AUTH_IMPERSONATION_ENDED', 'This impersonation session has ended. Return to the platform console and start a new one.', 401);
  }
}

/**
 * SECURITY.md §2: impersonation is read-only. Enforced once, structurally,
 * by a small middleware mounted ahead of every business router
 * (`src/auth/impersonation-guard.js`) — this is the one error it throws,
 * regardless of which module or permission the mutating request would
 * otherwise have reached.
 */
class ImpersonationReadOnlyError extends AppError {
  constructor() {
    super('FORBIDDEN_IMPERSONATION_READ_ONLY', 'Impersonation is read-only — this action cannot be performed while viewing a tenant as platform staff.', 403);
  }
}

module.exports = {
  InvalidCredentialsError,
  AccountLockedError,
  TokenExpiredError,
  TokenInvalidError,
  WrongAudienceError,
  UnauthenticatedError,
  SessionInvalidError,
  MfaNotImplementedError,
  MfaCodeInvalidError,
  NoActivePropertyError,
  PermissionDeniedError,
  ImpersonationEndedError,
  ImpersonationReadOnlyError,
  ValidationError,
  DuplicateEntryError,
};
