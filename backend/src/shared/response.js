'use strict';

/**
 * The response envelope — API.md §2. Every response, success or failure, uses
 * the same three top-level keys, so a client never branches on "is this
 * endpoint different."
 */

/** `{ data, meta, error: null }` — meta is `{}` unless the caller supplies one (list endpoints). */
function ok(data, meta = {}) {
  return { data, meta, error: null };
}

/**
 * `{ data: null, meta: {}, error }` — `code` is the namespaced string from
 * API.md §3, `details` is the optional field/issue array from the same spec,
 * and `requestId` ties the response to the audit log row for this request
 * (SECURITY.md §6) and to the matching `auth_events.request_id` where one
 * exists.
 */
function fail(code, message, { details, requestId } = {}) {
  return {
    data: null,
    meta: {},
    error: { code, message, details: details ?? null, request_id: requestId ?? null },
  };
}

/**
 * The bare 404 API.md §5 requires for "resource doesn't exist or belongs to
 * another tenant" — deliberately carrying no distinguishing detail, so an
 * unresolved tenant domain and someone else's record look identical on the
 * wire.
 */
function notFound(res) {
  res.status(404).json({ data: null, meta: {}, error: { code: null, message: 'Not found.', details: null, request_id: res.req?.requestId ?? null } });
}

module.exports = { ok, fail, notFound };
