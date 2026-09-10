'use strict';

/**
 * Group Blocks module error types — API.md §3, PLAN.md Phase 4. Only errors
 * that recur across more than one service function as a genuine business
 * rule get their own class here — matching AR's own restraint
 * (`ar/errors.js`'s header). `ArAccountNotFoundError`/`CompanyProfileNotFoundError`
 * are imported from `../ar/errors` rather than duplicated — this module
 * already depends on `ar/service.js` one-way (see `service.js`'s own
 * header), the same precedent `cashiering/service.js` already established
 * for importing `ArAccountNotFoundError` directly.
 */

const { AppError } = require('../../shared/errors');

/** 422, not 404 — used mid-mutation once a group_block_id has already been resolved from a URL param elsewhere in the same request; plain GET-by-id reads use the standard notFound(res) helper instead. */
class GroupBlockNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_GROUP_BLOCK_NOT_FOUND', 'The specified group block does not exist at this property.', 422);
  }
}

class GroupBlockCancelledError extends AppError {
  constructor() {
    super('BUSINESS_RULE_GROUP_BLOCK_CANCELLED', 'This group block has been cancelled and can no longer be modified.', 422);
  }
}

class GroupBlockNotSponsoredError extends AppError {
  constructor() {
    super('BUSINESS_RULE_GROUP_BLOCK_NOT_SPONSORED', 'This group block has no sponsoring company profile to bill its rooming list to.', 422);
  }
}

module.exports = {
  GroupBlockNotFoundError,
  GroupBlockCancelledError,
  GroupBlockNotSponsoredError,
};
