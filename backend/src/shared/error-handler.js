'use strict';

/**
 * The central error handler — API.md §2/§3. Extracted from `src/app.js` so
 * anything that builds its own small Express app (the real one, or a test
 * harness exercising `authenticate`/`requirePermission` against synthetic
 * routes) shares the exact same failure-shaping code rather than a
 * reimplementation that could quietly drift from it.
 *
 * Every route calls `next(error)` rather than shaping its own failure
 * response, so this is the one place an `AppError` becomes the envelope and
 * the one place an unanticipated error is guaranteed not to leak a stack
 * trace or a database message to the client (API.md §2: "never return a bare
 * stack trace").
 */

const { fail } = require('./response');
const { AppError } = require('./errors');

// Express recognises error-handling middleware by arity — `next` must stay in
// the signature even though this handler never calls it.
function errorHandler(error, req, res, next) {
  if (error instanceof AppError) {
    res.status(error.httpStatus).json(fail(error.code, error.message, {
      details: error.details,
      requestId: req.requestId,
    }));
    return;
  }

  // Logged with full detail server-side; returned to the client with none
  // (API.md §3's row for 500 INTERNAL_).
  console.error(`[${req.requestId}] Unhandled error:`, error);
  res.status(500).json(fail('INTERNAL_ERROR', 'Something went wrong.', { requestId: req.requestId }));
}

module.exports = { errorHandler };
