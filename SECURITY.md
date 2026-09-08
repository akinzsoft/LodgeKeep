# SECURITY.md

Companion to `AGENT.md`. Read this before any authentication, authorization, or data-access change. Tenant isolation (§2) is the single highest-severity concern in the system.

## 1. Non-negotiable engineering constraints

- **Security is first-class, not an afterthought.** HTTPS/TLS everywhere, encryption at rest for guest PII and payment data, input validation against OWASP Top 10 (injection, XSS, CSRF), rate limiting and brute-force protection on auth endpoints, scheduled encrypted backups.
- **No plaintext card data, ever.** All card/payment data flows through Paystack/Flutterwave tokenisation. Do not log raw payment payloads.
- **Every folio/rate/reservation change is audited.** Write to an audit trail (who, what, when, before/after) for anything touching money or room state.
- **Business-date rollover is a first-class concept.** Night audit must be a discrete, idempotent process that advances the property's business date; nothing should silently assume `new Date()` == the hotel's current business date.
- **Multi-property from the start.** Even for a single-property MVP, every relevant table should carry a `property_id` foreign key so multi-property support (PRODUCT_REQUIREMENTS.md §3.13) doesn't require a schema rewrite later.
- **RBAC on every route.** Front desk, cashier, housekeeping, manager, admin, super-admin — enforce at the API layer, not just hidden in the UI.

### 1.1 Security requirements (full checklist)

Treat every item below as a build requirement, not a nice-to-have — hotel PMS handles PII and payment data, so these get reviewed at code-review time, not bolted on before launch:

- **Authentication & authorization**
  - RBAC enforced server-side on every route (never trust a hidden UI element as the only gate)
  - JWT/session tokens with sane expiry + refresh; no long-lived tokens for privileged roles
  - Rate limiting and brute-force protection (lockout/backoff) on all auth endpoints
  - Password policy + hashing via bcrypt/argon2 — never store passwords in plain or reversible form
- **Data protection**
  - TLS in transit across the entire application, including internal service-to-service calls
  - Encryption at rest for guest PII (names, contact info, ID/passport numbers if collected) and any payment-adjacent data
  - Tokenised payment processing only — card data never persisted in the app's own database, in logs, or in error reports
  - Scheduled, encrypted backups with a tested recovery procedure (a backup that's never been restored isn't a backup)
- **Application security**
  - Input validation and parameterized queries everywhere (Knex handles this by default — never string-concatenate SQL)
  - Protection against OWASP Top 10: injection, XSS, CSRF, broken access control, security misconfiguration
  - CORS locked down per environment; guest portal, admin, and API origins explicitly allow-listed, not `*`
- **Audit & accountability**
  - Full audit trail (§6 of this file, `audit_log` table) on reservation, folio, rate, and room-status changes — who, what, when, before/after state
  - Void ≠ delete: financial records are soft-voided, never hard-deleted, so nothing disappears from the audit trail
  - Admin actions (user role changes, permission grants, rate overrides) are audited at the same standard as guest-facing changes
- **Operational security**
  - Secrets (DB credentials, Paystack/Flutterwave keys, JWT signing secret) in environment variables / a secrets manager — never committed to the repo
  - Principle of least privilege for service accounts (e.g. the reporting service shouldn't have write access to `folio_line_items`)
  - Dependency updates tracked; don't let known-vulnerable npm packages sit unpatched

## 2. Tenant isolation (SaaS — highest severity)

Cross-tenant data leakage is the most severe defect class in this system. It is worse than downtime: an outage is recoverable, a hotel seeing a competitor's rates and guest list is not. Treat these as absolute:

- **Scope at the data-access layer, not per query.** Every tenant-owned table is reached through a scoped accessor that injects `tenant_id` automatically. A developer forgetting a `WHERE tenant_id = ?` on one query must not be able to leak data — the architecture, not developer discipline, is the control.
- **`tenant_id` comes from the authenticated session, never from the request.** A `tenant_id` in a URL, body, or header is an attack, not an input. Same for `property_id`: verify the authenticated user is entitled to that property before honouring it.
- **Every object lookup verifies ownership.** Fetching reservation 4211 must confirm it belongs to the caller's tenant before returning it — an ID that exists but belongs to someone else returns 404, not 403 (a 403 confirms the record exists, which is itself a leak).
- **Test isolation explicitly.** Every module needs a test that authenticates as tenant A and attempts to read, update, and delete tenant B's records. This is not optional coverage; it is the test suite's most important job.
- **Platform staff access is separate and audited.** Planmsys support staff needing to view a customer's data use an explicit, time-bounded impersonation path that is logged, visible to the tenant, and never a silent super-admin flag. Customer trust in a hosted PMS depends on this being defensible.
- **Backups, exports, and reports are tenant-scoped too.** These are the usual places isolation quietly fails — a report that joins across tenants, or an export job that reads the whole table, defeats every other control.
- **Uploaded files are scoped.** Room photos, logos, and import files live under tenant-scoped paths with access checks — never a public bucket with guessable URLs.



## 3. Authentication identity design — the property_id correction

An earlier draft of this spec said session tokens carry a single `property_id`. That contradicts the fact that one user can hold access to several properties via `user_property_access` (DATABASE.md). The corrected model:

```
User identity
    |
tenant_id                 -- fixed for the session, embedded in the token
    |
authorized properties     -- the set from user_property_access, fetched at login
    |
active property           -- chosen by the user, changed by an explicit switch action
```

- The access token carries `tenant_id`, `role` (where the role is tenant-wide — see §4), and the user's id. It does **not** hardcode a single `property_id`.
- The **active property** is session state, set on login (default: the user's only property, or their last-used one) and changed only through an explicit context-switch endpoint.
- **Every request that touches property-scoped data is verified server-side against `user_property_access` for the currently active property** — never trust a client-supplied `X-Property-ID` header or query param as authorization. The header may *indicate* which property the request concerns, but the server looks up whether that user actually has access to it before honouring the request. This is TESTING.md ISO-6.
- Switching active property does not require a new login — it's a lightweight session update, re-verified against `user_property_access` on the switch itself.

## 4. Role model — the explicit rule

Given `user_property_access` carries `role` per property, the model is:

```
User → Property → Role → Permissions
```

**not** a single global role per user. State this explicitly so an agent never takes a shortcut:

> A user's role is never global unless it is explicitly a tenant-level administrative role (`super-admin`). Every operational role — front desk, cashier, housekeeping, manager, POS operator — is assigned per property, in `user_property_access`. A user with `manager` at Property A and `front_desk` at Property B is a normal, expected case, not an edge case.

This is what prevents an agent from writing `if (user.role === 'manager')` as a global check — the correct check is always "does this user have this role *at this property*."

## 5. Authorization matrix

Every endpoint is checked against this matrix, not against role name alone — a role check without a matrix behind it tends to drift as endpoints are added. `✓` full access, `Limited` scoped/read-mostly access (defined per endpoint), `Read` view-only, `✗` no access.

| Role | Reservations | Front Desk | Cashiering | Housekeeping | POS | Reports | Setup | Notifications | Night Audit |
|---|---|---|---|---|---|---|---|---|---|
| Front desk | ✓ | ✓ | Limited | Read | ✗ | Limited | ✗ | ✗ | ✗ |
| Cashier | Read | ✗ | ✓ | ✗ | ✗ | Limited | ✗ | ✗ | ✗ |
| Housekeeping | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| POS operator | ✗ | ✗ | ✗ | ✗ | Limited | ✗ | ✗ | ✗ | ✗ |
| Manager | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Read | Read | ✓ |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Super-admin (tenant) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (+ billing, cross-property) | ✓ | ✓ |

**Night Audit** (PLAN.md Phase 2.5), the column this matrix did not have until that pass: manager/admin/super_admin only, `night_audit.view`/`night_audit.run` — closing a business date is a manager-level action, not an operational front-desk/cashier one, this session's confirmed decision recorded here rather than left implicit in route code alone. **Cashiering's "Limited" cell** (front desk), also left undefined until that pass: `cashiering.post_charge` only — view a folio, post a charge — never `cashiering.void_line` (payments, refunds, voids, split billing), which cashier/manager/admin/super_admin hold in addition. **POS operator's cell** (PLAN.md Phase 4), corrected from a plain "✓" to `Limited` in this pass, the identical shape Cashiering's own front-desk cell already took: `pos.operate` only — run the register (view outlets/terminals/menu, open/view orders and shifts, add items, void an item before settlement, settle a tab including charge-to-room, blind cash-up) — never `pos.manage` (outlet/terminal/menu configuration, and the "Manager overrides" PRODUCT_REQUIREMENTS.md §3.4 names explicitly: discounts, comps, post-settlement voids), which manager/admin/super_admin hold in addition. A plain "✓" for pos_operator would have let a line-level operator reconfigure the whole outlet — the same over-grant this file's own text elsewhere warns a matrix-less role check invites.

"Limited" is defined per endpoint at implementation time (e.g. front desk's cashiering access is post-a-charge, not void-a-line), but must be written down in that module's own doc, not left implicit. Manager's Setup access is resolved as `Read`, not `Limited` — the UI-screens spec restricting Setup & Configuration screens to Admin/super-admin only made "Limited" undefined and contradictory; a manager can view configuration for context but cannot change it, matching the UI restriction exactly rather than inventing a partial-write shape nothing else in the spec called for. **Every API endpoint is tested against this matrix** — TESTING.md's AUTH suite and the isolation suite together, not a single role-name assertion.

**PLAN.md Phase 3 additions, both this session's confirmed decisions, not literal spec text:**

- **Reports' "Limited" cell**, now real (`src/modules/reporting`): `reports.view` — occupancy and housekeeping figures only, no revenue. `reports.view_financial` (manager/admin/super_admin only) additionally unlocks the revenue/ADR/RevPAR report. Front desk and cashier hold `reports.view` alone, matching their "Limited" cell above.
- **Notifications has no equivalent row in the original matrix** — confirmed by reading this file directly before adding one. Resolved the same way Setup's own manager-vs-admin split already works, rather than inventing an unrelated shape: manager gets read-only (`notifications.view` — the delivery log, "the guest never got it" lookup), admin/super_admin get full access (`notifications.manage` — template editing, resend). The in-app bell itself needs no permission at all: every authenticated staff member reads only their own `in_app_notifications` rows regardless of role, the same way any user reads their own session.

## 6. Audit log — full field set

The `audit_log` table (DATABASE.md) carries more than entity/action/before/after. The full set, because "who changed this and was it a person or a job" is a question that comes up constantly in a financial system:

```
tenant_id, property_id       -- scoping, so audit queries stay tenant-safe like everything else
entity_type, entity_id       -- what changed
action                       -- create/update/void/status_change
user_id                      -- who (nullable when source is a job, not a person)
before_state, after_state    -- JSON snapshots
occurred_at
request_id                   -- correlates to the originating HTTP request, for tracing
ip_address, user_agent       -- forensic context for a disputed change
source                       -- web | api | job | migration | platform_impersonation | integration
reason                       -- populated where the action required one (voids, refunds, overrides)
```

`source` in particular is what lets a manager answer "was this reservation change made by a person or by night audit rolling the date forward" without guessing.
