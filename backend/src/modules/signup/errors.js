'use strict';

/**
 * Signup module error types — API.md §3, PLAN.md Phase 5.
 */

const { AppError } = require('../../shared/errors');

/**
 * PRODUCT_REQUIREMENTS.md §3.22's own "duplicate email handling" — this
 * codebase's deliberate business rule that one email founds at most one
 * tenant via self-service signup (see `tenant_signups`' own migration
 * header for why this is a real DB constraint, not a soft check). Distinct
 * from the generic `DuplicateEntryError` a slug collision raises, so the
 * frontend can show a different message ("sign in instead?" vs. "pick a
 * different subdomain").
 */
class SignupEmailAlreadyUsedError extends AppError {
  constructor() {
    super(
      'CONFLICT_SIGNUP_EMAIL_ALREADY_USED',
      'An account already exists for this email address. Sign in instead, or use a different email to create a new organization.',
      409
    );
  }
}

module.exports = { SignupEmailAlreadyUsedError };
