# TESTING.md

Companion to `AGENT.md`. The complete testing reference for this project — strategy, stack, and every required test case in one place. Read before marking any work complete.

## Part 1 — Strategy

A PMS holds money and multi-tenant data, so correctness matters more than coverage percentage. Prioritise tests by what breaks the business, not by what is easy to test.

**Tests are a definition of done, not a follow-up task.** A module without the tests below is unfinished, not shipped-and-pending. Do not open work as complete, and do not move to the next module, while its required tests are missing — in a system that posts charges to real guests across multiple tenants, untested code is a liability rather than progress. `PLAN.md` carries the per-phase gate lists.

### Test stack & layout

**Jest + Supertest against a real MySQL test schema** — not mocks. The behaviours most worth testing here (unique constraints, foreign keys, transaction rollback, row locking on the last-room race) are database behaviours; mocking the DB tests the mock.

```
/backend
  jest.config.js
  /tests
    /helpers
      global-setup.js   (rebuild schema from migrations; refuse to run unless DB name contains "test")
      setup.js          (app instance, auth token minting, per-test transaction wrapper)
      fixtures.js       (two-tenant seed — see Ground Rules below)
    /isolation          (cross-tenant, table-driven over every entity)
    /auth
    /setup
    /reservations
    /cashiering
    /night-audit
    /housekeeping
    /portal
    /platform
```

Run with `runInBand` — the suite shares one schema, and the concurrency test needs real connection-level contention rather than worker noise.

Isolation tests are table-driven over a list of tenant-scoped entities, so a newly added endpoint inherits every check automatically and coverage cannot silently lag behind new routes.

### Coverage, environments, and release gates

**Coverage by risk, not a blanket percentage.** Money, night audit, availability, isolation, and auth: every branch including failure paths (enforce ~90% branch coverage on those paths in `jest.config.js`). Other backend modules: happy path, validation failures, isolation. Frontend: shared components fully, feature screens smoke-tested for the six states.

**Environments**: separate dev, staging, production, with staging on a schema identical to production. Migrations run against a production-shaped dataset before release, since they execute against every tenant at once (PRODUCT_REQUIREMENTS.md §1.1).

**Before a release**: migration backwards-compatible and reversible; isolation suite green; night audit runs cleanly on staging seed data; the six UI states exist on any new screen; no hardcoded colours or currency symbols introduced.

**Merge discipline**: a failing test blocks the merge rather than being skipped — a stray `.only` or `.skip` reaching CI fails the build. Every production bug gets a failing test reproducing it *before* the fix, so it cannot quietly return.

**Monitoring in production**: error tracking with tenant context attached; alerting on failed payments, failed email sends, and night audits that did not run for a property by their expected time. A night audit that silently fails to run is invisible until the numbers are wrong the next morning.

### Definition of done

A feature is not complete unless every applicable line below is true. This is the gate PLAN.md's per-phase "tests required to close" lists assume.

```
[ ] Database migration (backwards-compatible, reversible)
[ ] Backend route, following API.md conventions
[ ] Input validation
[ ] Authorization check against the matrix in SECURITY.md §5 — not just a role-name check
[ ] Service-layer logic separated from the route handler
[ ] Transaction wrapping where ARCHITECTURE.md §4 requires it
[ ] Audit logging where SECURITY.md §6 requires it
[ ] Cross-tenant isolation test (TESTS.md §1)
[ ] Business-logic tests for the module's required cases (TESTS.md)
[ ] Frontend screen, if applicable
[ ] Loading, empty, error, success, confirmation, and offline states as applicable (DESIGN_SYSTEM.md §2)
[ ] No hardcoded tenant-specific values, colours, or currency symbols
[ ] API documented (endpoint, request/response shape, error codes)
```

An agent should treat an unchecked box as unfinished work, not as a follow-up task to raise separately — the same standard `AGENT.md`'s "Working conventions for agents" section states for testing generally.

---

## Part 2 — Test cases (134 total)

### Ground rules

- **Real database.** Migrations run against a dedicated test schema before the suite; each test file runs in a transaction rolled back afterwards, so tests don't leak state into each other.
- **Two tenants in every fixture set, with overlapping IDs** — tenant A's reservation `1` and tenant B's reservation `1` both exist. Single-tenant fixtures hide the exact bug that matters most.
- **Money assertions are exact.** `expect(total).toBe('1250.00')` on the string/DECIMAL value. Never `toBeCloseTo`, never float tolerance.
- **A failing test blocks the merge.** Skipping (`.skip`, `.only` left in) fails CI.
- **Every production bug gets a failing test reproducing it before the fix.**

---

### 1. Isolation suite (highest priority — SECURITY.md §2)

Runs against **every** module. Generated from a table of endpoints rather than hand-written per module, so a new endpoint without isolation coverage is visible.

| # | Test | Expect |
|---|---|---|
| ISO-1 | Tenant A reads tenant B's record by ID, every entity | 404 (never 403 — a 403 confirms the record exists) |
| ISO-2 | Tenant A updates tenant B's record | 404, record unchanged |
| ISO-3 | Tenant A deletes tenant B's record | 404, record still present |
| ISO-4 | `tenant_id` supplied in body/query/header conflicting with session | Ignored; session wins |
| ISO-5 | List endpoints return only the caller's tenant rows | Count matches tenant A's fixture count exactly |
| ISO-6 | User without access to property X requests property X data | 403 |
| ISO-7 | Report/export job for tenant A contains no tenant B rows | Row-level assertion, not just count |
| ISO-8 | Uploaded file URL from tenant B fetched as tenant A | 404 |

---

### 2. Auth (PRODUCT_REQUIREMENTS.md §3.16)

| # | Test | Expect |
|---|---|---|
| AUTH-1 | Valid credentials | 200 + access & refresh token, tenant/property/role in claims |
| AUTH-2 | Wrong password / unknown email | Identical generic message both cases (no account enumeration) |
| AUTH-3 | Repeated failures | Lockout after threshold; lockout is per-account **and** per-IP |
| AUTH-4 | Many failures from one IP, different accounts | Shared front-desk IP not locked out for legitimate users |
| AUTH-5 | Expired access token | 401 |
| AUTH-6 | Refresh token after revocation | 401 — revocation takes effect immediately (dismissal case) |
| AUTH-7 | Password reset token | Single-use; second use rejected; expires |
| AUTH-8 | Password reset completes | All existing sessions invalidated |
| AUTH-9 | MFA-required role without MFA | Challenge issued, not full access |
| AUTH-10 | Deactivated user's live session | 401 on next request |
| AUTH-11 | Password stored | Hash only; plaintext never present in DB or logs |
| AUTH-12 | Guest account credentials on a PMS route | 401 — separate identity populations |
| AUTH-13 | Platform user without impersonation reads tenant data | 403 |
| AUTH-14 | Any auth event | Row in `auth_events` |
| AUTH-15 | Unlisted route without a token | 401 — authenticated by default, public routes are an allow-list |

---

### 3. Setup & configuration (PRODUCT_REQUIREMENTS.md §3.19)

| # | Test | Expect |
|---|---|---|
| SET-1 | Bulk room creation, range 101–160 | 60 rooms, correct type/floor |
| SET-2 | Duplicate room number within a property | Rejected (unique constraint) |
| SET-3 | Same room number in a different property | Allowed |
| SET-4 | Tax rate changed | Existing folio tax amounts unchanged |
| SET-5 | New charge after tax change | Uses new rate |
| SET-6 | Rate calendar override for a date | Wins over rate-code base rate |
| SET-7 | Deactivate a user | Status changed, record retained, audit references intact |
| SET-8 | Setup wizard partial state | Resumes at the right step |

---

### 4. Reservations & availability (PRODUCT_REQUIREMENTS.md §3.2, ARCHITECTURE.md §11)

| # | Test | Expect |
|---|---|---|
| RES-1 | Search with all rooms free | Full sellable count returned |
| RES-2 | Search with N booked | Sellable reduced by N |
| RES-3 | Booking at the overbooking threshold | Succeeds |
| RES-4 | Booking past the threshold | Rejected with a clear reason |
| RES-5 | **Two concurrent requests for the last room** | Exactly one succeeds; the other fails cleanly with no partial write |
| RES-6 | Out-of-order room | Excluded from sellable inventory |
| RES-7 | Booking creates `reservation_daily_rates` | One row per night, rate captured at booking time |
| RES-8 | Rate code changed after booking | Existing reservation's nightly rates unchanged |
| RES-9 | Departure before arrival | Rejected |
| RES-10 | Cancellation | Status changed, inventory released, audit row written |

---

### 5. Front desk (PRODUCT_REQUIREMENTS.md §3.3)

| # | Test | Expect |
|---|---|---|
| FD-1 | Check-in | Status `checked_in`, room occupied, folio opened |
| FD-2 | Check-in to a dirty room | Blocked or warned per configuration |
| FD-3 | Room move | New `reservation_rooms` row; prior row closed with `effective_to`; **history preserved** |
| FD-4 | Check-out with balance | Blocked until settled |
| FD-5 | Late check-out past the cutoff | Fee posted as its own labelled folio line, not folded into room charge |
| FD-6 | Early departure | Configured penalty posted |
| FD-7 | Walk-in when oversold | Oversell position surfaced before the sale is allowed |

---

### 6. Cashiering & money (PRODUCT_REQUIREMENTS.md §3.5, ARCHITECTURE.md §7–8) — exact DECIMAL only

| # | Test | Expect |
|---|---|---|
| CSH-1 | Folio total | Sum of lines, exact to the minor unit |
| CSH-2 | Tax on a charge | Computed per config; rounding boundary (e.g. `.005`) asserted explicitly |
| CSH-3 | Split three ways with odd remainder | Splits sum exactly to the original; remainder assigned deterministically |
| CSH-4 | Partial refund | Balance exact; original charge intact |
| CSH-5 | Void a line | Line remains queryable, `voided_at` and reason set, excluded from balance |
| CSH-6 | Void without a reason | Rejected |
| CSH-7 | Multi-currency folio | Each line carries its currency; no bare amounts |
| CSH-8 | Payment success | Folio balance reduced, `payments` row, gateway ref stored |
| CSH-9 | Payment decline | No folio line created |
| CSH-10 | Gateway timeout | No double charge; retry is safe |
| CSH-11 | Duplicate gateway webhook | Processed once (idempotent on gateway ref) |
| CSH-12 | Any money mutation | Audit row with before/after |

---

### 7. Night audit (PRODUCT_REQUIREMENTS.md §3.10, ARCHITECTURE.md §6) — the silent-failure suite

| # | Test | Expect |
|---|---|---|
| NA-1 | Run for a business date | Room charge posted to each in-house folio; date rolls forward |
| NA-2 | **Run twice for the same date** | Second run rejected; no double-posted charges |
| NA-3 | **Killed mid-run, then re-triggered** | No duplicate charges; completes cleanly |
| NA-4 | Failure mid-run | Whole run rolls back (single transaction) |
| NA-5 | In-house reservation with no open folio | Flagged, not silently skipped |
| NA-6 | `daily_reports` snapshot | Figures match underlying folio data |
| NA-7 | Property timezone ≠ server timezone | Correct business date used throughout |
| NA-8 | **Check-in at 23:59 vs 00:01 either side of rollover** | Each posts to the correct business date |
| NA-9 | Two properties, different business dates | Each rolls independently; no global state |
| NA-10 | Run stalls (no heartbeat update) past the timeout | Monitor marks it `STALE`; recovery check runs, per ARCHITECTURE.md §6.3 |
| NA-11 | Stale run where the transaction never actually committed | Marked `FAILED`; a fresh run from `READY` succeeds with no partial data present |
| NA-12 | Stale run where the transaction *did* commit but the completion marker was lost | Recovery detects the existing `daily_reports` row + business-date advance and marks `COMPLETED` after the fact — no re-run triggered, no duplicate charges |
| NA-13 | Night audit emits `night_audit.completed` to the outbox | Outbox row exists in the same transaction as the business-date advance; still present even if the dispatch worker never ran |

---

### 7A. Financial immutability & broadened idempotency (ARCHITECTURE.md §7–8)

| # | Test | Expect |
|---|---|---|
| IMM-1 | "Correct" a posted charge | Original row unchanged; a reversing adjustment and a new correct charge are posted as separate rows |
| IMM-2 | Attempt to `UPDATE` a posted charge's amount directly | Rejected at the service layer — no code path allows it |
| IDEM-1 | Refund request retried with the same idempotency key | Second call returns the stored response from the first; no second refund created |
| IDEM-2 | Void request retried with the same idempotency key | Same — one void, not two |
| IDEM-3 | POS room-charge posting retried with the same idempotency key | Same — one charge, not two |
| IDEM-4 | Checkout retried with the same idempotency key | Same — folio closes once |
| IDEM-5 | **Same idempotency key reused with a different amount** | Rejected as a conflict (`409 CONFLICT_IDEMPOTENCY_KEY_REUSE`), not silently processed and not silently returning the old response |
| IDEM-6 | Idempotency key reused after its retention window expires | Treated as a new, unrelated operation |

---

### 8. Housekeeping (PRODUCT_REQUIREMENTS.md §3.6)

| # | Test | Expect |
|---|---|---|
| HK-1 | Attendant reports a status differing from front desk | `has_discrepancy` true; neither value overwritten |
| HK-2 | Discrepancy present | Room blocked from resale until resolved |
| HK-3 | Discrepancy resolved | Flag cleared, resolution audited |
| HK-4 | Status change | `room_status_history` row with `source` recorded |
| HK-5 | Room marked out-of-order | Removed from sellable inventory (cross-check RES-6) |

---

### 9. Guest portal (PRODUCT_REQUIREMENTS.md §3.14) — separate identity surface

| # | Test | Expect |
|---|---|---|
| PRT-1 | **Guest session on any PMS route** | 401 — highest-value test in this phase |
| PRT-2 | Staff session on a guest-account route | 401 |
| PRT-3 | Booking end to end | Availability → book → pay → confirmation email → visible on arrivals board |
| PRT-4 | Payment fails mid-booking | No orphaned reservation, no orphaned charge |
| PRT-5 | Guest checkout without an account | Booking succeeds |
| PRT-6 | Portal for tenant A | Tenant A branding only; no admin styling leakage |

---

### 10. POS & AR (PRODUCT_REQUIREMENTS.md §3.4, §3.9)

| # | Test | Expect |
|---|---|---|
| POS-1 | Charge to room | Lands on the correct open folio |
| POS-2 | Charge to a closed folio | Rejected |
| POS-3 | Charge to another property's room | Rejected (isolation) |
| AR-1 | Invoice from folios | Total matches source folio lines |
| AR-2 | Ageing buckets | Correct at 30/60/90 boundaries |
| AR-3 | Charge over credit limit | Blocked or flagged per config |
| GRP-1 | Block pickup count | Matches reservations actually made against the block |

---

### 11. Notifications (PRODUCT_REQUIREMENTS.md §3.21)

| # | Test | Expect |
|---|---|---|
| NOT-1 | Booking confirmation | `notification_log` row, status `sent` |
| NOT-2 | Provider delivery webhook | Log status updated |
| NOT-3 | Hard bounce | Surfaced to staff, not swallowed |
| NOT-4 | Transient failure | Retried with backoff |
| NOT-5 | Email body | Contains no card data, no password, no full payment instrument |
| NOT-6 | Tenant template override | Used in preference to the default |

---

### 12. SaaS platform (PRODUCT_REQUIREMENTS.md §3.22)

| # | Test | Expect |
|---|---|---|
| SAAS-1 | Gated endpoint on a lower plan, called directly | Rejected at the API, not merely hidden in UI |
| SAAS-2 | Trial expiry | Read-only degradation; **live reservations still readable** |
| SAAS-3 | Offboarding export | Contains the tenant's complete data |
| SAAS-4 | Impersonation | Logged, time-bounded, visible to tenant, ends cleanly |
| SAAS-5 | Platform console outside impersonation | Cannot read tenant rows |
| SAAS-6 | Migration dry run | Writes nothing |
| SAAS-7 | Duplicate guests on import | Surfaced for decision, never auto-merged |
| SAAS-8 | Import rollback | Fully reverses the run |

---

### 12A. Door access — PHASE 2 (PRODUCT_REQUIREMENTS.md §3.23)

Not part of the MVP build (PLAN.md gates this on lock hardware being confirmed for a given tenant) — but the spec and schema exist now, so the tests are written now too, ready for whenever a property is actually configured with a lock adapter other than `none`.

| # | Test | Expect |
|---|---|---|
| LOCK-1 | Key card encoded at check-in | `pos_order_tokens`-equivalent for door cards created; card maps to the correct reservation and room |
| LOCK-2 | Invalid/unrecognised card presented at a lock | Access denied; if the property's adapter reports it, a `result: denied` event is still ingested (not silently dropped — a pattern of denied attempts is itself a signal) |
| LOCK-3 | Guest card opens the room it was issued for | No alert — this is the expected case, and the ingest path must not flag ordinary access |
| LOCK-4 | Guest card opens a room it was **not** issued for | `unsold_occupancy` or equivalent rule fires; alert raised (ARCHITECTURE-level rules in PRODUCT_REQUIREMENTS.md §3.23) |
| LOCK-5 | Card used after the guest has checked out | `post_checkout_access` rule fires; `critical` severity |
| LOCK-6 | Card tied to a reservation that was subsequently cancelled | Alert fires — the card should have been deactivated at cancellation; this test also verifies cancellation actually revokes the card, not just that the alert fires |
| LOCK-7 | Master/staff card used | Event recorded with `card_type: staff`, `staff_user_id` populated; no alert unless it falls outside that staff member's assigned shift/room (`staff_card_anomaly`) |
| LOCK-8 | The same physical door-open event delivered twice by the lock vendor | Deduplicated on (lock_system, external_event_id) — exactly one `door_access_events` row, not two |
| LOCK-9 | Manual CSV import of a pulled audit trail | Events created, each flagged `is_retrospective: true`, `ingestion_mode: manual_import` |
| LOCK-10 | The same CSV file imported twice (a real operator habit) | No duplicate events — same dedupe key as LOCK-8 applies regardless of ingestion mode |
| LOCK-11 | Real-time webhook event (networked/TTHotel-tier adapter) | Processed immediately; `is_retrospective: false`; detection rules evaluate on ingest, not deferred to the next night-audit sweep |
| LOCK-12 | Door event for a room belonging to another tenant's property | Rejected at ingest — tenant isolation (SECURITY.md §2) applies to hardware-sourced data exactly as it does to anything else |
| LOCK-13 | Door event older than the configured retention window | Handled per the property's retention policy (PRODUCT_REQUIREMENTS.md §3.23's legal/privacy note) — not kept indefinitely by default |
| LOCK-14 | A `critical` alert is raised | Manager/admin notified via the top-bar bell and, per the property's config, email — front desk and housekeeping do **not** receive it (PRODUCT_REQUIREMENTS.md §3.23) |

---

### 13. Frontend (DESIGN_SYSTEM.md §1–2)

| # | Test | Expect |
|---|---|---|
| FE-1 | Each shared component | Renders loading, empty, error states |
| FE-2 | Component source | No literal hex or currency symbol outside `tokens.css` (lint rule) |
| FE-3 | Money display | Tabular numerals; currency always shown |
| FE-4 | Status pill | Carries a text label, not colour alone |
| FE-5 | Role-filtered sidebar | Housekeeper sees no Cashiering item |
| FE-6 | Session expiry mid-action | Returns to login with an explanatory message, not a blank redirect |
| FE-7 | Touch targets on mobile views | ≥ 44×44px |

---

### Coverage expectations

Not a blanket percentage — targets by risk:

- **Money, night audit, availability, isolation, auth**: every branch, including failure paths
- **Other backend modules**: happy path + validation failures + isolation
- **Frontend**: shared components fully; feature screens smoke-tested for the six states
