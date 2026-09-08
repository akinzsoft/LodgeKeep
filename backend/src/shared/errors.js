'use strict';

/**
 * Error types — API.md §3 (error envelope), CLAUDE.md (namespaced codes).
 *
 * Every error carries a stable machine-readable `code` namespaced by domain
 * (`VALIDATION_`, `AUTH_`, `FORBIDDEN_`, `CONFLICT_`, `PAYMENT_`,
 * `BUSINESS_RULE_`, `LOCKED_`, `INTERNAL_`) and a human sentence for `message`.
 * The HTTP layer turns these into the `{ data, meta, error }` envelope; nothing
 * here knows about Express, so services and jobs can throw the same types.
 *
 * Only the scoping errors exist so far — they are what the data-access layer
 * needs. The rest arrive with the modules that raise them.
 */

/**
 * Base class. `httpStatus` is advisory: the route layer decides the final
 * status, because some of these are deliberately re-mapped. SECURITY.md §2:
 * a cross-tenant record access is answered 404, never 403, since a 403 confirms
 * the record exists — so a scope failure that reaches the HTTP layer must not
 * blindly propagate its own status.
 */
class AppError extends Error {
  constructor(code, message, httpStatus, details) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    if (details) this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * A table was queried that has no scope declaration in
 * `src/shared/table-scopes.js`.
 *
 * ARCHITECTURE.md §3: "A new table must declare its scope before it can be
 * queried through the accessor; there is no 'unscoped' query path." This is a
 * programming error rather than a request error — the fix is a registry entry,
 * never a retry — so it is INTERNAL_ and 500.
 */
class ScopeDeclarationError extends AppError {
  constructor(table) {
    super(
      'INTERNAL_SCOPE_UNDECLARED',
      `Table "${table}" has no scope declaration. Add it to src/shared/table-scopes.js ` +
        'before querying it (ARCHITECTURE.md §3).',
      500,
      { table }
    );
  }
}

/**
 * The context cannot satisfy the scope the table requires — a PROPERTY_SCOPED
 * table queried with no active property, or a tenant-owned table reached from a
 * platform context that holds no impersonation grant.
 *
 * A request error, not a bug: it is what an unentitled property switch or a
 * missing session field produces. 403 by default (TESTING.md ISO-6), which the
 * route layer downgrades to 404 when the answer would otherwise confirm that a
 * record exists.
 */
class ScopeContextError extends AppError {
  constructor(message, details) {
    super('FORBIDDEN_SCOPE_CONTEXT', message, 403, details);
  }
}

/**
 * A query or write tried to cross the scope it was issued under: an insert
 * naming a different tenant, an update trying to move a row between tenants, or
 * a compiled statement that reached the tripwire without its scope predicate.
 *
 * Always a bug, and always fatal to the request. It is deliberately not
 * recoverable and deliberately not a 4xx — if this fires in production, code
 * that believed it was scoped was not, and the only safe response is to fail.
 */
class ScopeViolationError extends AppError {
  constructor(message, details) {
    super('INTERNAL_SCOPE_VIOLATION', message, 500, details);
  }
}

/**
 * A request's shape or values are invalid — API.md §3's `VALIDATION_` prefix.
 * `code` is the specific suffix (e.g. "PASSWORD_TOO_SHORT"); this class
 * namespaces it under `VALIDATION_` so callers never have to remember the
 * prefix themselves. Generic and cross-cutting on purpose — any module can
 * raise one, not just auth, so it lives here rather than in a single
 * module's own error file.
 */
class ValidationError extends AppError {
  constructor(code, message, details) {
    super(`VALIDATION_${code}`, message, 400, details);
  }
}

/**
 * A generic MySQL duplicate-key error (`ER_DUP_ENTRY`) has no `AppError`
 * mapping anywhere else in this codebase — `src/shared/error-handler.js`
 * only recognises `AppError` instances, so an unwrapped duplicate-key error
 * falls through to a bare `500 INTERNAL_ERROR` rather than API.md §3's
 * `409 CONFLICT_` namespace. Originally added in Phase 1's setup module
 * (TESTING.md SET-2) and moved here in Phase 2 once the reservations module
 * needed the identical mapping for its own UNIQUE constraints
 * (`confirmation_number`, `room_type_inventory`'s per-date row) — generic
 * and cross-cutting, the same reasoning `ValidationError` already lives
 * here rather than in a single module's own error file.
 */
class DuplicateEntryError extends AppError {
  constructor(resource, message) {
    super('CONFLICT_DUPLICATE_ENTRY', message, 409, { resource });
  }
}

/**
 * Wraps a write that can hit a UNIQUE constraint, mapping MySQL's raw
 * `ER_DUP_ENTRY` to a real `DuplicateEntryError` — originally built inline
 * in `setup/service.js` (Phase 1); promoted here once `pos/service.js`
 * became a second module needing the identical shape, the same "promote a
 * one-off once a second caller needs it" pattern this codebase already
 * followed for `runIdempotentMutation`/`money.js`/`ulid.js`.
 */
async function withDuplicateMapping(resource, message, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new DuplicateEntryError(resource, message);
    }
    throw error;
  }
}

module.exports = {
  AppError,
  ScopeDeclarationError,
  ScopeContextError,
  ScopeViolationError,
  ValidationError,
  DuplicateEntryError,
  withDuplicateMapping,
};
