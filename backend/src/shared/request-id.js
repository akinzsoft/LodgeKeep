'use strict';

/**
 * Request-id middleware — API.md §2 ("request_id ties the response back to
 * the audit log entry"), SECURITY.md §6.
 *
 * One id per request, attached before any handler runs, so every envelope,
 * every `auth_events` row and every future `audit_log` row written while
 * handling this request can share the same identifier.
 */

const crypto = require('crypto');

function requestId() {
  return function attachRequestId(req, res, next) {
    req.requestId = `req_${crypto.randomUUID()}`;
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}

module.exports = { requestId };
