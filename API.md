# API.md

Companion to `AGENT.md`. The REST API contract every backend module follows. Read `ARCHITECTURE.md` §3 (entity scoping), §4 (transactions), §5 (concurrency), §6 (night audit), and §7 (payment state machine) first — this file is the wire format for the behaviour those sections define, not a replacement for them.

## 1. Base conventions

```
Base path:        /api/v1
Response shape:    { data, meta, error }
Auth:              Bearer access token on every request except the public allow-list
                    (SECURITY.md §1) — see §4 below for what "public" actually means
Dates:             ISO-8601 throughout, always with an explicit timezone or UTC — never a bare
                    date assumed to mean "the server's date" (ARCHITECTURE.md §6 depends on this)
Money:             DECIMAL as a string in JSON ("1250.00"), never a float — mirrors DATABASE.md
IDs:               BIGINT auto-increment for internal PKs (matches the Knex/MySQL schema in
                    DATABASE.md); UUIDs only where an ID must be guessable-safe and generated
                    client-side before the row exists (an idempotency key, not a row PK)
Idempotency:       required on every financial-mutation endpoint (ARCHITECTURE.md §7) via an
                    Idempotency-Key header
Versioning:        /api/v1 now; a breaking change ships as /api/v2 rather than mutating v1
                    under existing tenants
```

A module that returns a differently shaped response, invents its own error format, or accepts unbounded filter/sort parameters is not following the contract — flag it at review time the same as a missing test.

## 2. Response envelope

Every response, success or failure, uses the same three top-level keys. A client never has to branch on "is this endpoint different."

**Success**

```json
{
  "data": { ... } ,       // or an array, for list endpoints
  "meta": {                // present on list endpoints; omitted or {} on single-resource ones
    "page": { "cursor": "eyJpZCI6MTIzfQ", "has_more": true, "limit": 50 }
  },
  "error": null
}
```

**Failure**

```json
{
  "data": null,
  "meta": {},
  "error": {
    "code": "FOLIO_ALREADY_CLOSED",
    "message": "This folio is closed and cannot accept new charges.",
    "details": [
      { "field": "folio_id", "issue": "folio.status is 'closed'" }
    ],
    "request_id": "req_9f2c1a"
  }
}
```

`code` is a stable, machine-readable string a frontend can switch on without parsing prose. `message` is the human-readable sentence DESIGN_SYSTEM.md §2 says an error state must show. `request_id` ties the response back to the audit log entry (SECURITY.md §6) for that request — the two must share the same identifier.

Never return a bare stack trace, a database error message, or an HTTP framework's default error body. Every error a client can see passes through this envelope.

## 3. Error codes

A namespaced code per domain, not a generic `VALIDATION_ERROR` for everything — specificity here is what lets a frontend show the right message and what lets support diagnose an incident from logs alone.

| HTTP status | Code prefix | Example | Meaning |
|---|---|---|---|
| 400 | `VALIDATION_` | `VALIDATION_ARRIVAL_AFTER_DEPARTURE` | Request shape is fine, the values aren't |
| 401 | `AUTH_` | `AUTH_TOKEN_EXPIRED`, `AUTH_INVALID_CREDENTIALS` | Not authenticated, or authentication failed |
| 403 | `FORBIDDEN_` | `FORBIDDEN_PROPERTY_ACCESS`, `FORBIDDEN_ROLE` | Authenticated, not authorized (SECURITY.md §5's matrix) |
| 404 | — | Bare 404, no body needed beyond the envelope | Resource doesn't exist **or belongs to another tenant** — see §5 below, this is deliberate |
| 409 | `CONFLICT_` | `CONFLICT_ROOM_UNAVAILABLE`, `CONFLICT_NIGHT_AUDIT_ALREADY_RUN`, `CONFLICT_FOLIO_ALREADY_CLOSED` | A concurrency or state conflict (ARCHITECTURE.md §5) |
| 402 | `PAYMENT_` | `PAYMENT_DECLINED`, `PAYMENT_GATEWAY_TIMEOUT` | Gateway-level payment failure (ARCHITECTURE.md §7) |
| 422 | `BUSINESS_RULE_` | `BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED`, `BUSINESS_RULE_CREDIT_LIMIT_EXCEEDED` | Request is valid and permitted, but violates a configured business rule |
| 423 | `LOCKED_` | `LOCKED_ACCOUNT` | Rate-limited/locked out (SECURITY.md's auth rules) |
| 429 | `RATE_LIMITED` | | Too many requests |
| 500 | `INTERNAL_` | `INTERNAL_ERROR` | Unexpected failure — logged with full detail server-side, returned to the client with none |

New codes are added under the existing prefix for their domain; a new prefix is only introduced for a genuinely new failure category, not per endpoint.

## 4. Authentication

Three identity populations, three token issuers, three sets of routes — see PRODUCT_REQUIREMENTS.md §3.16 and SECURITY.md §3 for the full design. At the API layer this means:

- **`/api/v1/*`** (the PMS proper) accepts staff tokens only. A guest or platform token here returns `401 AUTH_WRONG_AUDIENCE`.
- **`/api/v1/portal/*`** accepts guest tokens only, or no token for public browsing/booking endpoints (availability search, menu browsing).
- **`/api/v1/platform/*`** accepts platform-staff tokens only, and every route here that touches tenant data requires an active impersonation grant (SECURITY.md §2) — checked per request, not just at token issuance.
- The **public allow-list** is small and explicit: login endpoints for all three audiences, password-reset request, guest availability search, guest menu browsing, and webhook receivers (which authenticate by signature, not by bearer token — ARCHITECTURE.md §7). Every other route requires a valid token by default; a route is public because it's on this list, never because a decorator was forgotten (this is what TESTING.md AUTH-15 verifies).

## 5. Resource endpoint conventions

**Tenant/property scoping is implicit, never a URL or body parameter.** There is no `/api/v1/tenants/{id}/reservations` — the scope comes from the authenticated session (ARCHITECTURE.md §3, SECURITY.md §2), and a client attempting to pass `tenant_id` in a request gets it silently ignored (TESTING.md ISO-4), not honoured.

```
GET    /api/v1/reservations                 list, scoped to the active property
GET    /api/v1/reservations/{id}            single resource
POST   /api/v1/reservations                 create
PATCH  /api/v1/reservations/{id}            partial update
POST   /api/v1/reservations/{id}/cancel     an action that isn't a plain field update
DELETE /api/v1/reservations/{id}            only where the domain genuinely allows deletion
                                             (rare — most PMS entities void or archive instead,
                                             per DATABASE.md §3)
```

**Actions that aren't CRUD** (check-in, void, cancel, refund) are `POST` to a sub-path naming the action, not an overloaded `PATCH` with a status field — this keeps the audit trail's `action` column (SECURITY.md §6) unambiguous and matches it one-to-one with an endpoint.

**Cross-tenant record access always returns 404, never 403.** A 403 confirms the record exists somewhere; that's a leak (SECURITY.md §2, TESTING.md ISO-1). This is the one place the status-code table above is deliberately "wrong" by REST convention — correctness for tenant isolation overrides convention here.

**Property switching** is its own endpoint, not a header trusted at face value:

```
POST /api/v1/auth/switch-property   { "property_id": 42 }
```

verified server-side against `user_property_access` before the session's active property changes (SECURITY.md §3).

## 6. Pagination, filtering, sorting

```
Pagination:  cursor-based for high-volume lists (reservations, folio lines, audit log,
             notification log); offset acceptable for small/bounded lists (room types,
             rate codes, users). ?cursor=... &limit=50
Filtering:   explicit allow-list of filterable fields per endpoint, documented per module —
             never pass query params straight into a WHERE clause. e.g.
             GET /api/v1/reservations?status=confirmed&arrival_date_from=2026-04-01
Sorting:     explicit allow-list of sortable fields, same reasoning.
             ?sort=arrival_date&order=asc
```

An endpoint's allow-lists live in that module's own route definition, reviewed the same way its authorization check is — an unbounded filter is a query-injection-shaped risk even when it isn't literally SQL injection.

## 7. Webhooks (inbound)

Payment gateway webhooks are the main case (ARCHITECTURE.md §7), but the same shape applies to any inbound webhook (door-lock events in PRODUCT_REQUIREMENTS.md §3.23, once that phase is active).

```
POST /api/v1/webhooks/{provider}
```

- **Verified** by signature before anything else touches the payload — an unauthenticated POST claiming to be Paystack is not trusted on the strength of its shape.
- **Persisted** immediately, before processing — a crash mid-handling must not lose the event.
- **Deduplicated** on the provider's own event/reference id (DATABASE.md's unique constraints).
- **Processed idempotently** — replaying the same webhook twice produces the same end state.
- **Responds `200` once persisted**, regardless of whether processing has finished — providers retry on anything else, and a slow synchronous handler shouldn't turn a webhook receiver into the system's timeout bottleneck. Processing can be asynchronous from receipt.

## 8. What belongs here vs. in ARCHITECTURE.md

To keep the two files from drifting into overlapping, possibly-contradictory copies of the same rule: **ARCHITECTURE.md owns the behaviour** (when a transaction is required, how locking works, the payment state machine, the night audit sequence). **This file owns the wire format** (what the HTTP request/response looks like for that behaviour). If a review of one file suggests a change that affects the other, update both in the same pass.
