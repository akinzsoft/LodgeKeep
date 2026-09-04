# ARCHITECTURE.md

Companion to `AGENT.md`. This is the technical architecture: tech stack, repo layout, entity scoping, transactions, concurrency, and the two hardest correctness problems in a PMS — night audit and payment state. Read this before writing any module that touches money, availability, or the business date. See `API.md` for how this behaviour is exposed over HTTP.

## 1. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js + Express | REST API, modular service architecture — one module folder per PMS module |
| Database | MySQL | Relational schema; use proper foreign keys between guests, reservations, folios, rooms, and properties — this is transactional, money-touching data, so favour normalized tables and DB-level constraints over denormalized documents |
| Query layer | Knex.js | Query builder, not a full ORM — gives parameterized queries, transactions, and migration files without fighting the joins night audit/reporting need. Migrations live in `/backend/migrations` and are checked into the repo. |
| Frontend | React (responsive web) | Must work on desktop, tablet, and front-desk terminals — design mobile/tablet-first for front desk and housekeeping screens |
| Auth | JWT / session-based, RBAC — three separate identity populations (staff, guests, platform staff), see PRODUCT_REQUIREMENTS.md §3.16 | Token carries `tenant_id` + `property_id` scope. Roles: front desk, cashier, housekeeping, manager, admin, super-admin (tenant-wide), plus Planmsys platform staff (see SECURITY.md §2) |
| Payments | Pluggable gateway layer; Paystack (cards/digital) and Flutterwave (NQR) as the launch adapters | Gateway is per-tenant configuration. Modules call the payment interface, never a provider SDK directly, so a new market means a new adapter rather than edits across the codebase. Never store raw card data — tokenised processing only. |
| POS integration | Custom POS terminal API + hardware terminals (bar/restaurant) | Terminal count varies per customer — never hardcode. Terminals must be NFC/contactless-capable (tap-to-pay), not chip/swipe-only — confirm this at procurement time with the Flutterwave/Paystack POS hardware SKU ordered, since it's a hardware spec, not something the integration layer can add later. |
| Hosting | Cloud (Planmsys infra) | Shared multi-tenant deployment, single codebase, one database with tenant-scoped rows. No on-prem, no per-customer instances |
| Background jobs | Redis + BullMQ | Per-tenant concurrency limits so one large customer can't starve the rest. See §14 for the full queue design (night audit, reports, exports, imports, email sends). |
| Rate limiting | Redis-backed (`express-rate-limit` + `rate-limit-redis`) | Never in-memory — an in-memory store resets on deploy and doesn't work once there's more than one backend instance. See §15 for the tiered policy. |

Do not introduce a different backend language/framework, ORM, or database without discussing it — the stack above is fixed for the product, and every tenant runs on the same codebase.

**This is a modular monolith, not microservices — deliberately.** One Express app, one database, module boundaries enforced by folder structure and code review (§2), not by network calls between services. Splitting into microservices would mean distributed transactions across the exact boundaries §4–§8 depend on being atomic within one database — reservation creation, night audit, and payment capture all rely on a single local transaction. Revisit this only if a specific module demonstrably needs independent scaling that the monolith can't provide (e.g. the night-audit worker under genuine load), and even then, extract that one module — don't restructure the whole system speculatively.

## 2. Repo structure

Two top-level folders, `backend` and `frontend`, kept as separate deployable applications with no shared build. They communicate over the REST API only — the frontend never imports backend code, and the backend never renders views.

```
/backend
  /src
    /modules
      /profiles
      /reservations
      /front-desk
      /cashiering
      /housekeeping
      /rooms
      /group-blocks
      /accounts-receivable
      /night-audit
      /pos             (outlets, menus, orders, shifts, cash-up, QR guest ordering,
                        inventory & stock control — see 3.4)
      /access-monitoring  (door-event rules engine + fraud alerts — PHASE 2, see 3.23)
      /reporting
      /revenue-management
      /multi-property
      /tenancy         (tenant records, plan entitlements, scoped data-access layer — see SECURITY.md §2)
      /billing         (subscription plans, subscription billing — see 3.22)
      /setup           (property, room type, rate, tax, user configuration — see 3.19)
      /migration       (import templates, dry run, dedupe, rollback — see 3.20)
      /notifications   (email templates, delivery log, retry — see 3.21)
    /integrations
      /paystack
      /flutterwave-nqr
      /pos
      /door-locks      (key card encoding; door-event ingestion — PHASE 2, see 3.23)
        /adapters      (one per vendor: hiread-prousb, hiread-elock, hiread-tthotel,
                        generic-csv — all normalising to one event shape)
      /channel-managers
    /auth              (staff/guest/platform login, sessions, MFA, RBAC — see 3.16)
    /audit             (audit trail middleware/service)
    /jobs              (BullMQ workers, one file per queue — night audit, reports,
                        exports, imports, outbox dispatch, email — see §14)
    /shared            (shared models, utils, error types)
  /migrations          (Knex migrations — checked in, run against every tenant)
  /seeds               (test/demo data, incl. the two-tenant isolation fixtures — see TESTING.md)
  /tests

/frontend
  /src
    /app               (routing, layout shell, providers)
    /styles            (tokens.css — the single source for all design tokens, see 6.1)
    /shared
      /components      (card, KPI card, status pill, data table, icon badge, toast,
                        confirm dialog, skeleton — see 6.1/6.1.1)
      /hooks
      /api             (typed API client; the only place that talks to the backend)
    /features          (mirrors backend modules — reservations, front-desk, cashiering,
                        housekeeping, rooms, reporting, setup, migration, billing …)
    /portal            (guest-facing, tenant-themed: booking site (PRODUCT_REQUIREMENTS.md §3.14) and
                        QR table/room ordering pages (3.4) — no login, no app install)
  /public
  /tests
```

**Backend conventions.** Each module folder is self-contained: routes, controller, service, model. Cross-module calls go through service functions, not direct model access, so module boundaries stay enforceable. Anything long-running — night audit, reports, exports, imports, bulk email — belongs in `/jobs`, not an inline request handler, so one large tenant can't degrade service for the rest (PRODUCT_REQUIREMENTS.md §1.1).

**Frontend conventions.** `/features` mirrors the backend module names, so a change traces cleanly across both sides. All design tokens live in `/styles/tokens.css` and nowhere else; components reference tokens, never literal values, or tenant theming silently breaks (DESIGN_SYSTEM.md §1). All network calls go through `/shared/api` — no direct fetch calls scattered through feature code, since tenant context, auth headers, and error handling are applied there.

**The guest portal ships from the same frontend app** but is visually independent: tenant-themed from config, no admin shell, its own routes under `/portal`. Keeping it in one codebase avoids duplicating the booking, availability, and payment logic; keeping it in its own route tree stops admin styling leaking into a guest-facing page.

**Two apps, one API contract.** Type definitions for API requests and responses are shared — either a generated client or a small shared package — so a backend field rename surfaces as a frontend compile error rather than a runtime bug in front of a hotel receptionist.

### 5.1 Data model conventions

These decisions apply across every table — agree them once here rather than re-litigating per module:

- **`tenant_id` on everything, `property_id` on everything operational.** Tenant is the paying customer; property is a physical hotel; one tenant may own several. Both columns exist from day one even for single-property customers — retrofitting the split later is expensive (PRODUCT_REQUIREMENTS.md §1.1).
- **Tenant-owned tables are never queried directly.** Access goes through the scoped accessor that injects `tenant_id` (SECURITY.md §2). Raw table access in a module is a review-blocking defect.
- **Money is `DECIMAL`, never `FLOAT`.** Rounding drift in a float column is unrecoverable in a financial system.
- **Every money column carries its currency.** Tenants operate in different currencies and some properties bill guests in more than one (3.5). A bare amount with an assumed currency is a defect.
- **Foreign keys use `RESTRICT`, not `CASCADE`,** on anything financial. A cascade delete that silently wipes folio history is worse than a failed delete.
- **Void, never delete.** Financial rows (folio line items in particular) are soft-voided with `voided_at` / `voided_by_user_id` and stay in the table. The audit trail depends on nothing disappearing.
- **`business_date` is stored on every posted transaction**, separate from `created_at`. The property's business date is the accounting truth; wall-clock time is not (PRODUCT_REQUIREMENTS.md §3.10).
- **Room assignment is a separate table from the reservation.** One reservation can occupy multiple rooms across its stay (room moves), each row with `effective_from` / `effective_to` — don't overwrite a `room_id` on the reservation and lose the history.
- **Sellable inventory is its own table**, per room type per date, carrying the overbooking threshold percentage — availability is checked against that, not against a count of physical rooms (PRODUCT_REQUIREMENTS.md §3.2).
- **Room status is two columns, not one**: front-desk-expected status and housekeeper-reported status, plus a discrepancy flag. Neither silently overwrites the other (PRODUCT_REQUIREMENTS.md §3.6).
- **Audit log stores before/after state as JSON** against an entity type + entity id, so any module can write to it without a schema change per entity.
- **(Phase 2, 3.23) Door access events are append-only.** No update or delete path exists in the application layer; dedupe on (lock system, vendor event id) because offline locks re-send overlapping batches. Store occurrence time and ingestion time separately — they diverge by seconds on a webhook and by days on a manual import.
- **(Phase 2, 3.23) Lock configuration is per-property data, not code** — vendor, tier, ingestion mode and real-time capability live in a config table so a hardware upgrade is a row update rather than a code change.



## 3. Entity scoping — the formal rule

Every table falls into exactly one of four scopes. This classification is not optional documentation — it determines which column(s) the scoped data-access layer (SECURITY.md §2) requires on every query against that table, and getting it wrong is how tenant isolation breaks.

| Scope | Carries | Examples | Rule |
|---|---|---|---|
| **PLATFORM_SCOPED** | nothing tenant-related | `platform_users`, `plans`, `impersonation_sessions` | Never joined against tenant data except through the audited impersonation path |
| **TENANT_SCOPED** | `tenant_id` only | `tenants`, `users`, `guests`, `company_profiles`, `roles`, `subscriptions`, `market_segments`, `booking_sources`, `loyalty_accounts`, `email_templates` | Shared across a tenant's properties. A guest or a company profile is the same record whether the guest stays at property A or B. |
| **PROPERTY_SCOPED** | `tenant_id` + `property_id` | `properties`, `rooms`, `room_types`, `rate_codes`, `taxes`, `reservations`, `folios`, `pos_outlets`, `stock_items`, `lock_system_config` | The overwhelming majority of operational tables. Belongs to one physical hotel. |
| **GLOBAL_REFERENCE** | neither | seeded lookup data only, if any exists | Reserved for genuinely tenant-independent reference data (e.g. a country/currency code list) — used sparingly, and never for anything a tenant can edit |

**Resolving the ambiguous cases from first principles:**

- `guests` — **TENANT_SCOPED**, not property-scoped. A tenant's central guest database (PRODUCT_REQUIREMENTS.md §3.13) is the entire point — a guest who stayed at property A and books property B is the same guest record. The property-specific part (stay history, first/last seen) lives in a join table — see DATABASE.md §1.1 for the `guests` / `guest_properties` split.
- `company_profiles` — **TENANT_SCOPED**. A corporate account or travel agent commonly books across a tenant's properties; splitting it per property duplicates the credit relationship.
- `room_types`, `rate_codes`, `taxes` — **PROPERTY_SCOPED**. Two properties in the same tenant can have entirely different room inventories and tax jurisdictions.
- `market_segments`, `booking_sources` — **TENANT_SCOPED** reference data, editable at the tenant level so reporting stays comparable across properties; a property may still filter down to a subset it uses.
- `loyalty_accounts` — **TENANT_SCOPED**. Loyalty follows the guest, not the property.
- `users` — **TENANT_SCOPED** identity; property access is a separate PROPERTY_SCOPED join (`user_property_access`) — see §5 below.

**Enforcement.** The scoped data-access layer (SECURITY.md §2) reads this classification and automatically applies the right `WHERE` clause per table — `tenant_id` only for TENANT_SCOPED, both columns for PROPERTY_SCOPED. A new table must declare its scope before it can be queried through the accessor; there is no "unscoped" query path.

**The one narrow exception: bootstrap lookup.** Login itself has a real chicken-and-egg problem — resolving *which* tenant a request belongs to necessarily happens before a `tenant_id` exists to scope by. A single declared primitive (`bootstrapLookup`, alongside the accessor) is the sole sanctioned way to query before a tenant is known, and it is restricted to columns that are **globally unique by their own constraint**, not merely convenient — `tenant_domains.domain` and `tenants.slug` are the reference cases, and each new column added to this exception needs the same justification and its own negative-controlled test, the same discipline `bootstrapLookup`'s own tests already apply. This is not a loophole for convenience queries; it exists because a global uniqueness constraint makes the lookup safe without a `tenant_id` to scope by in the first place, which is a fundamentally different situation from "we don't have the tenant_id handy right now."

## 4. Transaction boundaries

Financial and state-changing operations run inside a database transaction, full stop. A financial operation must never leave the database in a partially completed state — a request that fails halfway through must roll back everything it touched, not just report an error.

| Operation | Transaction required |
|---|---|
| Reservation creation | Yes — availability check, insert, and `reservation_daily_rates` in one transaction (§5 below) |
| Check-in | Yes — reservation status, room status, folio open |
| Room move | Yes — close old `reservation_rooms` row, open new one |
| Check-out | Yes — balance verification, reservation status, room status |
| Folio posting (any charge) | Yes |
| Payment capture | Yes — folio update + payment record together |
| Refund / void | Yes |
| Night audit | Yes — the entire run is one transaction (§6 below); a partial night audit is worse than a failed one |
| Stock movement | Yes — deducting recipe components on a sale is multiple rows that must agree |
| POS settlement | Yes — order status, folio or cash-up, stock deduction |
| Migration import (per batch) | Yes, with the whole run rolling back on any row the operator hasn't explicitly excepted |

A read-only endpoint does not need a transaction. When in doubt — does this operation write to more than one table, or does a partial write leave the data inconsistent — wrap it.

## 5. Concurrency & locking rules

The last-room booking race (TESTING.md RES-5) is the best-known concurrency hazard in a PMS, but it isn't the only one. Every row below needs the same treatment: a database-level lock or constraint, not an application-level check-then-write that assumes nothing else is happening at the same instant.

| Race | Two things happening at once | Required mechanism |
|---|---|---|
| **Last room** | Two guests book the last available room in a type/date | `SELECT ... FOR UPDATE` on the `room_type_inventory` row for that (property, room_type, stay_date) inside the reservation transaction, or an equivalent atomic decrement (`UPDATE ... SET sold = sold + 1 WHERE sold < threshold`, checking affected-row count) |
| **Double settlement** | Two cashier terminals settle the same folio simultaneously | Row lock on the folio during settlement; second attempt sees the folio already closed and fails cleanly |
| **POS tab edit** | Two staff modify the same open tab | Row lock on `pos_orders` during modification, or optimistic concurrency (a version column checked on write) |
| **Room assignment** | Two staff assign the same physical room | Unique constraint or row lock on the room during assignment; second assignment fails with a clear "already assigned" error, not a silent overwrite |
| **Night audit** | Two workers trigger the audit for the same property at once | Advisory lock or a `night_audit_runs` row inserted at the *start* of the run (unique on property + business date) before any posting happens — the second run sees the row exists and refuses immediately, rather than racing to post |
| **Stock depletion** | Two POS orders consume the last unit of a stock item at once | Row lock or atomic decrement on `stock_items.current_quantity`, mirroring the room-inventory pattern |
| **Payment reconciliation** | A gateway webhook and a user-initiated retry arrive together | Idempotency key (§7 below) — both attempts converge on the same payment record rather than racing to create two |

**The anti-pattern to explicitly avoid**, since it looks correct and isn't:

```
const available = await getAvailability();   // read
if (available > 0) {
  await createReservation();                 // write, later, unlocked
}
```

Between the read and the write, another request can run the same two lines. Both see availability, both write. The fix is never "add a check" — it's making the read and the decrement atomic within one locked transaction, as specified in the table above.

## 6. Night audit — exact sequence and recovery model

Different implementations of "run the night audit" produce different bugs if the sequence isn't fixed — and a worker crashing mid-run is not a hypothetical, it is the case this whole section is designed around.

### 6.1 Run states

Every night audit execution is itself a row (`night_audit_runs`, DATABASE.md) with its own state machine, checked before any posting happens:

```
READY -> RUNNING -> COMPLETED
RUNNING -> FAILED
RUNNING -> STALE (no heartbeat within the timeout) -> RECOVERABLE -> RUNNING (resumed) or FAILED
```

- **`READY`**: no run exists yet for this property + business date, or the previous run reached a terminal state. A new run may start.
- **`RUNNING`**: a worker holds the lock and is actively executing the sequence below. The row records `worker_id` (a unique identifier for the process instance running it, not just a hostname — two workers on the same host must be distinguishable) and `heartbeat_at`, updated periodically while the run executes.
- **`STALE`**: `heartbeat_at` has exceeded the configured timeout (recommended: 90 seconds without an update) while the row still says `RUNNING`. A stale run means the worker died, was killed, or lost its connection — it does **not** mean the audit failed; it means nobody knows yet.
- **`RECOVERABLE`**: a stale run that a monitor or the next attempt has confirmed is safe to resume or restart, based on what step it reached (see §6.3).
- **`COMPLETED`** / **`FAILED`**: terminal. A `COMPLETED` run for a property + business date blocks any further run for that same date (TESTING.md NA-2). A `FAILED` run returns the property to `READY` for that date, so a retry can start clean.

### 6.2 Sequence

This is the required order, and steps 4–13 run as a single database transaction (§4):

1. Validate the property (exists, not already `RUNNING` for this business date)
2. Insert the `night_audit_runs` row as `RUNNING`, acquiring the night-audit lock for this property + business date (§5) — a second concurrent run fails here, immediately, before touching anything (TESTING.md NA-2)
3. Validate unresolved blocking conditions (e.g. unassigned in-house reservations, if the property requires resolution before close)
4. Post room charges for every in-house folio, per the idempotency guard (skip if a charge already exists for this folio + business date — TESTING.md NA-2/NA-3)
5. Post package charges
6. Apply taxes (per the tax engine, §12 below)
7. Reconcile POS outlet totals for the business date into the relevant folios/cash-up
8. Reconcile payments received against posted charges
9. Generate the `daily_reports` snapshot (occupancy, revenue, ADR, RevPAR)
10. Flag exceptions (in-house reservation with no open folio, unresolved discrepancies) — these do not block the run, but must appear in the output (TESTING.md NA-5)
11. Close the business date
12. Advance `properties.current_business_date`
13. Mark the run `COMPLETED` and commit the transaction — steps 4–12 and the completion marker either all land or none do

A failure at any step rolls back the whole transaction; nothing from steps 4–12 survives a failure, and the run row records `FAILED` with the error (outside the rolled-back transaction, so the failure itself is never lost). This is what TESTING.md NA-4 verifies.

### 6.3 Recovery after a crash

A worker can die between steps — a container restart, an OOM kill, a lost database connection — after the transaction has started but before it commits. Because step 13's commit is atomic, one of exactly two things is true when a worker resumes or a replacement worker picks up a stale run:

- **The transaction never committed** (the common case — a crash mid-transaction rolls back automatically at the database level). The run row is `STALE`, nothing from steps 4–12 exists in the database, and the correct recovery is: mark the stale run `FAILED`, and let a fresh attempt start from `READY`. This is safe because nothing partial was ever visible — TESTING.md NA-3 (killed mid-run, re-triggered, no duplicate charges) is exactly this path.
- **The transaction committed but the run row update to `COMPLETED` didn't get acknowledged** (rare — a crash in the narrow window after commit but before the worker's own bookkeeping) — the run row may show `STALE` even though the audit actually completed. Recovery here must check reality, not just the run row: before restarting, the recovery path queries whether a `daily_reports` row and a business-date advance already exist for that property + date. If they do, the run is marked `COMPLETED` after the fact and no re-run is triggered. If they don't, treat it as the first case.

**A monitor process** sweeps for `RUNNING` rows whose `heartbeat_at` has exceeded the timeout, marks them `STALE`, and applies the check above. This must run independently of the audit workers themselves — a dead worker cannot be relied on to notice its own death.

**Retry** after a `FAILED` state is a fresh run through the full sequence from step 1 — never a partial resume from the failed step, since steps 4–12 are one transaction and there is no meaningful "partial" state to resume from once it has rolled back.

### 6.4 Critical transaction vs. post-commit side effects

Steps 4–13 above are the **critical transaction**: financial postings, payment reconciliation, business-date state, and the authoritative audit record. Nothing outside the database belongs inside that transaction boundary — an external HTTP call to an email provider inside the same transaction as a financial posting means a slow or failing email API can roll back (or, worse, hang) a business-date rollover, which is disproportionate and dangerous.

Everything that isn't a database write — emails, other notifications, generated reports, exports, analytics events, any external side effect — happens **after** the critical transaction commits, dispatched through the outbox (§13 below). The night audit's own emitted events (e.g. `night_audit.completed`) are written to the outbox table in the *same* critical transaction as everything else (so the event is never lost even if the worker dies immediately after commit), but the actual sending happens out-of-band, afterwards, by a separate worker that can retry independently without touching the financial data again.

## 7. Payment architecture — state machine and idempotency

**The one fact that shapes everything below: a MySQL transaction cannot atomically commit together with an external payment provider.** The database and Paystack/Flutterwave are two separate systems with no shared transaction. Any design that assumes "charge the card and update the folio in one atomic step" is wrong by construction. The required flow is always:

```
Application
  -> create a payment intent (local row, status INITIATED)
  -> call the external provider
  -> provider responds and/or sends a webhook
  -> verify, deduplicate, and apply the state transition idempotently (below)
  -> post the folio effect in the same local transaction as the state transition
```

The local database transaction is atomic; the round trip to the provider is not, and never will be. Idempotency (below) exists specifically to make that gap safe to retry.

**States.** Every payment record moves through a fixed set of states; a module must never invent an ad hoc status string.

```
INITIATED → PENDING → AUTHORIZED → CAPTURED
                    ↘ FAILED
                    ↘ EXPIRED
AUTHORIZED → VOIDED
CAPTURED → REFUNDED
CAPTURED → PARTIALLY_REFUNDED
any non-terminal state → CANCELLED
```

`CAPTURED`, `FAILED`, `EXPIRED`, `VOIDED`, `REFUNDED`, and `CANCELLED` are terminal — no further transition is valid from them except `CAPTURED → REFUNDED`/`PARTIALLY_REFUNDED`.

**Payment record fields** — the full set, so a module doesn't invent a partial version:

```
id, tenant_id, property_id, folio_id
idempotency_key
provider, provider_payment_id, provider_reference
amount, currency
status
failure_code, failure_reason
authorized_at, captured_at, failed_at, expired_at
parent_payment_id       -- links a refund back to the payment it refunds
created_at, updated_at
```

**Provider webhook events are persisted as their own records, separate from the payment record they affect** — a `payment_webhook_events` table (DATABASE.md), not folded into `payments`. This is what makes replay, audit, and "did we actually receive this webhook or did the provider never send it" answerable after the fact, independent of what the payment row currently says.

**The payment transaction record and the folio ledger effect are two different things that must stay consistent.** A captured payment produces (1) a `payments` row moving to `CAPTURED`, and (2) a corresponding `folio_line_items` row reducing the folio balance (DATABASE.md). Both are written in the same local database transaction (§4) — a payment that's `CAPTURED` with no matching folio line, or a folio line with no matching payment record, is a defect the isolation/financial test suite must catch (TESTING.md).

**Idempotency is mandatory, not a nice-to-have, on every financial mutation** — this is what TESTING.md CSH-10 (gateway timeout, safe retry) and CSH-11 (duplicate webhook) actually verify, and it is broader than gateway payments:

- **Idempotency applies to every important financial mutation**: payment capture, refund, void, POS room-charge posting, checkout, and any other financial posting — not payments alone. Any endpoint in `API.md`'s financial-mutation category (§6 there) requires an `Idempotency-Key` header.
- **Key scope and lifetime**: an idempotency key is scoped to one tenant + one operation type + the key value itself, and is honoured for a fixed retention window (recommended: 24 hours) — long enough to cover realistic retry scenarios, short enough that the table doesn't grow unbounded. After the window, the same key value may be reused for a new, unrelated operation.
- **Stored response**: the first request with a given key executes normally and its response is stored against that key. Every subsequent request with the same key, within the retention window, returns the *stored* response without re-executing the operation — it does not merely check "does a similar payment exist," it returns exactly what the first call returned.
- **Same key, different parameters**: if a repeated request reuses an idempotency key but with a different amount, folio, or other material parameter, that is **rejected** as a conflict (`409 CONFLICT_IDEMPOTENCY_KEY_REUSE` — API.md §3), not silently processed with the new parameters and not silently returning the old response. Reusing a key with different inputs is either a client bug or an attempted replay, and both need to fail loudly.
- Every gateway webhook is: **verified** (signature/secret check — never trust an unauthenticated POST claiming to be Paystack), **persisted** before processing (so a crash mid-handling doesn't lose it), **deduplicated** on the gateway's own event/reference id, **processed idempotently** (applying the same webhook twice produces the same end state, not a double credit), and **auditable** (every webhook received is logged, processed or not).
- A payment mutation without an idempotency key is a defect at review time, not a style note.

## 8. Financial ledger — immutability

**Financial records are immutable. A correction is a new transaction, never an edit to a historical one.** This is stricter than "void, never delete" (which already applied to `folio_line_items`) — it means even a *correction* doesn't touch the original row's amount, only adds an offsetting entry and then the corrected entry:

```
ROOM CHARGE   £100.00     (original, untouched)
ADJUSTMENT   -£100.00     (reverses it — new row, references the original)
CORRECT CHARGE £120.00    (the actual intended charge — new row)
```

The folio balance after all three is £120.00, and the full history — what was originally charged, that it was wrong, and what replaced it — remains readable forever. An agent implementing "fix this charge" as `UPDATE folio_line_items SET amount = ...` is violating this rule regardless of whether the void/audit columns get touched too.

This applies to every financial entity: charges, payments, refunds, adjustments, voids, discounts, deposits, transfers between folios, and write-offs. Each is its own row; none is ever mutated after creation except for the narrow, explicitly-audited void fields (`voided_at`, `void_reason`, `voided_by_user_id` — DATABASE.md).

## 9. API conventions

Moved to `API.md` — the full REST contract (response envelope, error codes, resource conventions, pagination, webhooks) lives there so it can be read on its own without pulling in the rest of this file. The idempotency requirement in §7 above and the transaction/locking rules in §4–§5 are the *behaviour* API.md's wire format implements; read both together when building an endpoint that touches money or availability.

## 10. ID strategy

One rule, applied everywhere, so no module invents its own:

```
Internal database PKs:      BIGINT UNSIGNED, auto-increment
API representation:         BIGINT IDs are represented as STRINGS in JSON — not numbers.
                             JavaScript's Number type loses precision above 2^53, and a
                             hotel doing high reservation volume across years will exceed
                             that. "id": "48213910" not "id": 48213910.
Public-facing identifiers:  UUID/ULID only where a value must be safe to expose without
                             revealing sequence/volume information — confirmation numbers,
                             QR tokens (PRODUCT_REQUIREMENTS.md §3.4), password-reset tokens.
                             Not a blanket replacement for internal PKs.
Idempotency keys:            a separate concept from any of the above — client-generated,
                             opaque, scoped to one financial operation (§7 below). Never
                             reuse an idempotency key as if it were a resource ID.
```

A module using `INT` instead of `BIGINT`, exposing a raw integer PK in a JSON response, or minting its own ID format is a defect at review time — this is exactly the kind of drift `MASTER` files exist to prevent, per `AGENT.md`'s reading order.

## 11. Reservation state machine

Reservations move through a fixed set of states. A module implementing "just update the status field" without following this machine is how a reservation ends up simultaneously confirmed and no-show, or checked out with an open inventory hold.

```
INQUIRY -> TENTATIVE -> CONFIRMED -> CHECKED_IN -> CHECKED_OUT

CONFIRMED  -> CANCELLED
CONFIRMED  -> NO_SHOW
TENTATIVE  -> EXPIRED
TENTATIVE  -> CANCELLED
```

`INQUIRY` and `TENTATIVE` are optional — a direct booking or a staff-entered confirmed reservation can skip straight to `CONFIRMED`. `TENTATIVE` exists for holds (a quote awaiting deposit, an OTA soft-hold) with an expiry.

**Every transition must define all seven of these, not just "change the status column":**

| Transition | Authorization | Preconditions | Inventory effect | Deposit effect | Folio effect | Notification | Audit event | Reversible? |
|---|---|---|---|---|---|---|---|---|
| → `TENTATIVE` | front desk+ | room type available | soft hold, counted against sellable inventory per §5's locking rule | none required yet | none | none | `create` | Yes — expires or is explicitly released |
| `TENTATIVE`/`INQUIRY` → `CONFIRMED` | front desk+ | availability still holds; deposit rules satisfied if the property requires one | hold becomes a firm allocation | deposit captured if required (§7 payment flow) | folio opened if none exists | booking confirmation email (via outbox, §13) | `status_change` | Yes → `CANCELLED` |
| `CONFIRMED` → `CHECKED_IN` | front desk | arrival date reached (or early check-in permitted); room assignable; folio open | allocation becomes an occupied room | n/a | room charge scheduling begins (posted at night audit, §6) | none required | `status_change` | Discouraged — a check-in reversal is a data-correction case, not a normal transition; requires manager override and is fully audited |
| `CHECKED_IN` → `CHECKED_OUT` | front desk/cashier | folio balance zero (or property permits checkout with balance owing to AR) | room released to housekeeping as dirty (`PRODUCT_REQUIREMENTS.md` housekeeping states) | n/a | folio closed | checkout receipt email (outbox) | `status_change` | No — checkout is terminal; corrections happen via new folio transactions (§8), never by reopening the stay |
| `CONFIRMED` → `CANCELLED` | front desk+, or guest via portal within policy | cancellation policy fee window checked | inventory released immediately | cancellation fee posted per policy if applicable | fee posted as its own line if applicable | cancellation email (outbox) | `status_change`, reason required | No |
| `CONFIRMED` → `NO_SHOW` | front desk, typically via night audit sweep | arrival date has passed with no check-in | inventory released (or retained for no-show fee period, per property config) | no-show fee posted per policy | fee posted | no-show notice (outbox) | `status_change` | No |
| `TENTATIVE` → `EXPIRED` | system (automated) | hold expiry timestamp passed | inventory released automatically | none | none | none, or a low-priority notice | `status_change`, `source: job` | No |

**Idempotency**: every transition endpoint accepts an idempotency key (§7), since "confirm this reservation" retried on a flaky connection must not double-book or double-charge a deposit.

This state machine is the authoritative reference for `PRODUCT_REQUIREMENTS.md` §3.2 (Reservations) and §3.3 (Front Desk) — those files describe what the screens do; this table is what the transitions are actually allowed to do underneath them.

## 12. Tax and currency engine

### 11.1 Tax

A `taxes` row (DATABASE.md) needs the full set below, not just a rate — this is what makes tax calculations correct across rate changes and reproducible after the fact:

```
tax_code                -- stable identifier, referenced by charges, never the display name
rate
effective_from, effective_to
inclusive / exclusive   -- is the configured room/item price tax-inclusive or does tax add on top
calculation_method      -- percentage of base, flat amount, tiered, etc.
priority                -- order of application when multiple taxes apply to one charge
compound / non-compound -- does this tax apply to the base amount, or to (base + prior taxes)
rounding_method         -- see below
jurisdiction             -- where the property needs to distinguish tax authorities
```

**Multiple and compound taxes**: a charge can carry more than one tax line (e.g. VAT + a tourism levy). `priority` fixes the order; `compound` determines whether the second tax computes against the base charge or against the base plus the first tax's amount. Both must be explicit per tax, not assumed.

**Inclusive vs exclusive pricing**: a room rate configured as tax-inclusive means the displayed/quoted price already contains the tax, and the tax line on the folio is the back-calculated portion, not an addition to the total. Getting this backwards either overcharges the guest or under-reports tax liability — the property's chosen mode (DATABASE.md's `taxes` config) must be respected consistently across quoting, booking, and folio posting, not decided freshly at each of those three points.

**Rounding**: fixed per tax (nearest minor unit, always round half-up — see also §1's DECIMAL rule) and applied at the same point in the calculation every time — rounding per line item versus rounding once on the total produces different totals on some inputs, so the method is a configuration decision, not left to whichever developer wrote a given endpoint.

**Discounts and partial refunds interact with tax**: a discount applied before tax changes the taxable base; a discount applied after tax does not. A partial refund must refund the correct proportion of both the charge and its tax, not just the charge. Both cases follow the same inclusive/exclusive and rounding rules as the original charge — a refund is not a fresh tax calculation with fresh rounding.

**Exemptions and overrides**: a specific guest, company, or charge type may be tax-exempt (diplomatic status, a corporate exemption certificate) — this is a flag at the charge or guest/company level that suppresses tax calculation for that line, itself audited (SECURITY.md §6) since it's a revenue-affecting override.

**Historical reproducibility — the rule that matters most**: changing a tax rate must never alter what a historical folio's tax lines say. This is stronger than "existing folio tax amounts unchanged" (already stated in PRODUCT_REQUIREMENTS.md §3.17) — it means the *calculation itself* must be re-derivable later using the tax rate that was `effective` on the date the charge was posted, not the current rate. Storing `effective_from`/`effective_to` per tax version, and always calculating against the tax version effective on the charge's `business_date`, is what makes a folio audit six months later reproduce the same numbers a guest was actually charged.

### 11.2 Currency

```
Property (base) currency  -- what the property's own accounting and reporting use
Reservation currency      -- what was quoted to the guest at booking
Folio currency            -- what the folio is denominated in (usually = reservation currency)
Payment currency          -- what was actually charged, which may differ (a foreign card
                             charged by a gateway that settles in a different currency)
FX source                 -- which rate provider/table is authoritative
FX precision              -- decimal places carried on the stored rate itself
```

**When the FX rate is locked**: at the point the guest commits to a price — booking confirmation for a quoted rate, or payment capture for a currency-converted charge — not recalculated later at settlement or at report time. Once locked, that rate is stored against the transaction (`currency_rates` linked from the relevant payment/folio row, DATABASE.md), so the transaction's value in the property's base currency never silently drifts as market rates move.

**Manual override**: a property may need to hand-enter a rate (bank-quoted rate for a specific large transaction, a rate the automated source didn't have same-day). An override is stored the same way as an automated rate — with its source recorded as "manual" and the entering user's id — never distinguished only by the *absence* of a source.

**Rounding and FX differences**: money is converted and then rounded to the target currency's minor unit using the same half-up rounding rule defined for tax above (§12.1). Where a small residual FX difference results (a payment converts to slightly more or less than the folio balance in base currency), that difference posts as its own labelled adjustment line — never silently absorbed into the payment amount or the folio balance.

**Money never uses floating-point arithmetic anywhere in this system** — DECIMAL columns in the database (DATABASE.md), DECIMAL strings over the wire (API.md §1), and a fixed-precision decimal library in application code. This is restated here because currency conversion is exactly the kind of calculation where a float bug is easiest to introduce and hardest to notice until a reconciliation fails months later.

## 13. Outbox — decoupling side effects from the critical transaction

The pattern referenced by §6.4 (night audit) and used everywhere else a business transaction needs to trigger something outside the database: an email, a notification, a report generation, an export, an external webhook call. None of those belong inside the same database transaction as the financial or state-changing write that triggers them (§4) — an external call inside a DB transaction turns that call's latency and failure modes into the transaction's latency and failure modes, which is backwards.

**The pattern**: the business transaction writes its normal state changes *and* an outbox event row, in the same commit. A separate worker polls (or is notified of) new outbox rows and dispatches the actual side effect afterwards, independently, with its own retry logic.

```
Business transaction
  -> database state change(s)
  -> outbox event row, same transaction
  -> COMMIT
  -> (separately, afterwards) worker picks up the event
  -> dispatches: email / notification / webhook / analytics / integration call
  -> marks the event processed (or retries on failure)
```

**Outbox event fields:**

```
event_id
tenant_id, property_id
event_type              -- e.g. "reservation.confirmed"
aggregate_type, aggregate_id   -- what this event is about (e.g. "reservation", 4821)
payload                  -- JSON, enough detail for the dispatcher to act without re-querying
created_at
processed_at
attempt_count
status                   -- pending / processing / sent / failed
last_error
```

**Why this specifically solves the night-audit-emails problem**: if night audit crashes after committing the business-date rollover but before sending confirmation emails, the outbox row for `night_audit.completed` already committed in the same transaction as the rollover — it is not lost, and the dispatch worker picks it up independently whenever it next runs, with no dependency on the audit process still being alive.

**Events worth emitting** (not exhaustive — add an event type when a module genuinely needs an async side effect, not preemptively for everything):

```
reservation.confirmed        reservation.cancelled
guest.checked_in             guest.checked_out
payment.captured             payment.refunded
folio.closed                 night_audit.completed
```

**Dispatch failures retry with backoff** (mirrors PRODUCT_REQUIREMENTS.md §3.20's notification retry rule) and a `failed` event after exhausting retries surfaces to staff the same way a hard email bounce does — an outbox event that silently stays `pending` forever is the async equivalent of a swallowed exception.

## 14. Redis and the job queue

**Redis is infrastructure, not a data store for anything durable.** Nothing here is the source of truth for money, reservations, or tenant state — that's always MySQL. Redis holds the queue itself, rate-limit counters, and short-lived session/cache data. If Redis is lost, the system degrades (jobs pause, rate limits reset) but no financial data is at risk, because none of it lives there.

**Queue technology: BullMQ**, backed by Redis. Chosen over a bare Redis list or a DB-polling queue because it gives retry-with-backoff, per-queue concurrency limits, delayed jobs (useful for scheduled report delivery, PRODUCT_REQUIREMENTS.md §3.11), and job status inspection out of the box — all things §13's outbox dispatcher and §6's night audit worker need and would otherwise be hand-rolled.

**Queue structure — one queue per job category, not one global queue:**

```
night-audit      -- one job per property per business date
outbox-dispatch  -- drains ARCHITECTURE.md §13's outbox_events table
reports          -- scheduled + on-demand report generation
imports          -- data migration runs (PRODUCT_REQUIREMENTS.md §3.20)
exports          -- report/data exports
email             -- outbox-triggered sends specifically (kept separate from
                    general outbox-dispatch so an email-provider outage doesn't
                    back up report generation)
```

**Per-tenant concurrency limits, enforced at the queue level.** Every job carries `tenant_id` in its payload; each queue's worker enforces a per-tenant concurrency cap (e.g. no more than 2 concurrent `reports` jobs for the same tenant) so one large customer running a heavy export can't starve every other tenant's jobs — this is what the stack table's "no large customer can starve the rest" line actually means in practice, not just an aspiration.

**Job design rules, following from §4 and §13:**

- A job's payload contains everything the worker needs to act — `{ tenant_id, property_id, event_type, aggregate_id }` at minimum — so the worker doesn't need to re-derive context from a stale read.
- **Jobs are idempotent.** BullMQ retries on failure; a retried `night-audit` job hits the same guard as a manually re-triggered one (§6.2's idempotency check), and a retried `outbox-dispatch` job re-sends an email that's already `sent` only if the outbox event's own status check catches it first (§13's `processed_at` field).
- **A job never writes financial data outside a transaction it owns.** The critical transaction (§6.4) has already committed by the time a job runs; the job's job is the side effect, not the financial write.
- Failed jobs, after exhausting BullMQ's retry policy, land in a dead-letter state visible to Planmsys platform staff (PRODUCT_REQUIREMENTS.md §3.22's platform console) — a job that silently disappears after failing is the async equivalent of a swallowed exception, same principle as §13's outbox failure handling.

**Redis is a single shared instance across tenants**, same as the database (§3) — job payloads and rate-limit keys are tenant-scoped by convention (`tenant_id` in the key/payload), not by separate Redis instances per tenant. Isolation here matters less than in the database, since Redis holds no data whose leakage would be catastrophic the way a cross-tenant folio read would be — but job payloads still shouldn't leak PII into logs or across tenants carelessly.

## 15. Rate limiting

Three tiers, each with a different reason to exist and a different limit shape — treating them identically under one blanket limit either starves legitimate traffic or lets abuse through.

**Interim state, worth tracking as a planned migration, not forgotten debt:** account lockout counting (SECURITY.md's auth rules) currently reads from `auth_events` in MySQL rather than Redis, because it was built before this section existed. That's the *correct* stopgap — it survives a restart, which an in-memory or premature Redis counter wouldn't — but a `COUNT` query per login attempt doesn't scale the way a Redis counter does. Move it to Redis once the job-queue/rate-limiting infrastructure in this section actually lands; until then, leave it as-is rather than build a second interim solution.

| Tier | Applies to | Limit shape | Why |
|---|---|---|---|
| **Auth** | Login, password reset, MFA challenge | Per-account **and** per-IP, tight (SECURITY.md's lockout rules) | Brute-force protection. Per-IP alone would lock out an entire shared front-desk terminal when one person mistypes a password repeatedly — both dimensions are required, not either. |
| **General API** | Every authenticated `/api/v1/*` route | Per-tenant, generous, sliding window (e.g. 300 req/min per tenant) | Protects against a runaway client (a buggy frontend polling loop, a misconfigured integration) rather than against malice — the limit should be high enough that no legitimate usage pattern ever hits it. |
| **Public/guest** | Guest portal booking search, QR ordering, webhooks | Per-IP and per-token (PRODUCT_REQUIREMENTS.md §3.4's "rate-limit orders per token, cap unpaid order value per table") | Unauthenticated surface — the only tier where a genuinely hostile actor has no account to lock, so IP and token are the only levers available. |

**Implementation**: `express-rate-limit` with a Redis store (`rate-limit-redis`), never the in-memory default — in-memory counters reset on every deploy and don't work at all once there's more than one backend instance running behind a load balancer, which the Redis-backed job queue (§14) already assumes is coming.

**Rate-limit responses follow API.md's contract**: `429 RATE_LIMITED` (API.md §3), with a `Retry-After` header so a well-behaved client backs off correctly instead of hammering the endpoint harder.

**Webhooks are exempt from the general per-tenant limit** but get their own ceiling — a payment gateway retrying a webhook aggressively during an outage shouldn't be treated as abuse, but also shouldn't be allowed to overwhelm the `outbox-dispatch` queue (§14) unbounded.

