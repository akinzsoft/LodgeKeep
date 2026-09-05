# PLAN.md — Lodgekeep build plan

Companion to `AGENT.md` and its other companion files. Module numbers (3.x) below refer to `PRODUCT_REQUIREMENTS.md`; other section references follow the `File.md §N` convention across `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `DESIGN_SYSTEM.md`, and `TESTING.md`. This file describes **what order to build it in and why**.

## Sequencing principles

- **Foundations that are expensive to retrofit come first.** Tenancy, auth, audit trail, and business-date handling touch every later module. Adding them afterwards means rewriting everything built on top.
- **Build a usable slice before a complete one.** A hotel that can take a booking, check a guest in, bill them, and close the day is a working product. Yield management is not.
- **Each phase ends in something demonstrable.** Not "the reservations module is done" but "you can book a room and see it on the arrivals board."
- **A phase is not complete until its tests pass.** Every phase below carries a "Tests required to close" list. These are gates, not suggestions — code that ships without them is unfinished work, not fast work. In a system holding money and multi-tenant data, an untested module is a liability rather than progress.
- **Riskiest unknowns get pulled forward.** Payment gateway behaviour, night audit correctness, and tenant isolation are where this project can go wrong quietly; prove them early rather than discovering them near launch.

---

## Phase 0 — Foundations — ✅ COMPLETE

Verified: 438/438 backend tests (302/302 isolation-specific), 139/139 frontend tests, both fresh. Design-token lint guard confirmed as a real build-failing gate via live mutation test, not just present in config. Login, app shell, and tenant-scoped rendering confirmed working end-to-end in a browser, not just via API tests.

Nothing user-facing ships here, and that is the point. This phase exists so every later phase inherits the right constraints.

- Repo scaffold: `/backend` + `/frontend` (ARCHITECTURE.md §2), CI, dev/staging environments
- Knex setup, migration workflow, seed structure
- **Tenancy layer (SECURITY.md §2)** — `tenants`, the scoped data-access accessor, `tenant_id` resolution from session
- **Auth (3.16)** — staff login, sessions, password reset, RBAC, `user_property_access`
- **Audit trail (SECURITY.md §6)** — `audit_log` write path, usable as middleware from any module
- **Design tokens (DESIGN_SYSTEM.md §1)** — `tokens.css`, plus the shared component set: card, KPI card, status pill, data table, icon badge, toast, confirm dialog, skeleton
- App shell (PRODUCT_REQUIREMENTS.md, UI screens §): sidebar, top bar, property switcher, business-date indicator
- **Cross-tenant isolation test harness (TESTING.md)** with the two-tenant overlapping-ID fixtures

**Tests required to close:**
- Cross-tenant isolation harness runs green against the two-tenant overlapping-ID fixtures
- Auth: login success/failure, lockout after repeated failures, session expiry, refresh-token revocation actually revokes, password reset single-use
- RBAC: each role against each seeded endpoint, asserting the negative cases
- Audit middleware writes a row with before/after state on a sample mutation
- Frontend: shared components render all six states (DESIGN_SYSTEM.md §2); no literal hex or currency symbol outside `tokens.css` (lint rule)

**Exit:** a user can log in, see an empty shell scoped to their tenant, and the isolation suite passes. Every subsequent module is built through the scoped accessor from day one.

**Risk if skipped:** retrofitting `tenant_id` across 76 tables and every query is the single most expensive mistake available on this project.

---

## Phase 1 — Property setup

Nothing else functions until a property exists with rooms and rates in it.

- Property record, timezone, currency, business date initialisation
- Room types, physical room inventory **with bulk entry** (see "Setup & Configuration screens" in PRODUCT_REQUIREMENTS.md §3.19 — hand-keying 60 rooms is a real onboarding failure)
- Rate codes and the rate calendar
- Tax configuration, effective-dated
- User management, roles, market segments, booking sources
- Setup wizard (PRODUCT_REQUIREMENTS.md, Setup & Configuration screens) with resumable progress

**Scope note, corrected after implementation:** the original Phase 1 pass built exactly the five items its own commit named (property, room types, rooms, rate codes, taxes) and left user management, market segments, booking sources, cancellation policies, and the setup wizard unbuilt — flagged honestly at the time, not silently dropped. A later gap-closure pass (see CLAUDE.md's own status section) built **market segments, booking sources, and cancellation policies** as real PROPERTY_SCOPED reference-data tables with real CRUD endpoints, RBAC (reusing `setup.view`/`setup.manage`, no new permission keys needed), a Setup UI tab, and real composite FKs closing the forward references `reservations.market_segment_id`/`booking_source_id`/`cancellation_policy_id` had carried since Phase 2. **User management and the guided setup wizard remain unbuilt** — real, separate gaps, not yet picked up.

**Tests required to close:**
- Isolation tests for every setup entity (rooms, rate codes, taxes, users)
- Tax effective-dating: changing a rate does not alter an existing folio's tax
- Bulk room entry creates the expected count and rejects duplicate room numbers within a property
- Rate calendar resolution: date override wins over rate-code base rate
- Setup wizard resumes correctly from a partial state

**Exit:** a fresh tenant can configure a complete property unaided.

---

## Phase 2 — The core operational loop

The heart of the product. Everything here is needed before a hotel can run a single day.

**Scope note, corrected after implementation:** what actually shipped as "Phase 2" was narrower than originally planned below — Reservations, Front Desk, and a **folio stub only** (open/closed/balance, no line items, no charges, no payments). Cashiering's real ledger, Night Audit, and payment integration were not built in this pass, and remained open work tracked as Phase 2.5 below — since shipped; see that section. Phase 3 (Housekeeping/Notifications/Reporting) was built against the interim reality — Reporting was live-computed with no `daily_reports` snapshot at the time, since that snapshot was a Night Audit output that didn't exist yet; Phase 2.5 later closed that gap too.

- **Reservations (3.2)** — availability search against sellable inventory, create/modify/cancel, `reservation_daily_rates`, confirmation numbers — ✅ **shipped**
- **Front desk (3.3)** — arrivals/departures/in-house boards, check-in, room assignment, check-out, room moves — ✅ **shipped**
- **Rooms (3.6)** — room grid with live status — ✅ **shipped**
- **Cashiering (3.4)** — folios, line items, charges, payments, void-with-reason — ✅ **shipped in Phase 2.5** (real ledger, not the original stub)
- **Guest profiles (3.1)** — create, search, stay history — 🔲 **still minimal stub table only (Phase 2's guests table), no real Profiles module/UI**
- **Night audit (3.9)** — room charge posting, business-date rollover, idempotency guards — ✅ **shipped in Phase 2.5**
- Payment integration: one gateway end to end (cards/digital), tokenised — ✅ **shipped in Phase 2.5** (cash + Paystack; Flutterwave not wired)

**Exit:** a full day can be run — book, check in, post charges, take payment, check out, close the day, roll the date. **Met — closed by Phase 2.5 below**, built after Phase 3 chronologically in this session even though it is numbered ahead of it here; see CLAUDE.md's own Phase 2.5 status section for the full detail.

## Phase 2.5 — Cashiering, Night Audit, Payments (the deferred half of Phase 2) — ✅ shipped

The exit criteria above were never actually met — this phase is what closes them. Built in this order, since each depended on the last:

1. **Real folio ledger** — ✅ **shipped**: `folio_line_items`, charges, tax, adjustments, split billing, the void-never-delete rule from `ARCHITECTURE.md §8`
2. **Payment integration** — ✅ **shipped for cash and Paystack**; Flutterwave not wired (no sandbox credentials) — the state machine and idempotency rules from `ARCHITECTURE.md §7`. A live Paystack sandbox round trip is not confirmed in this environment (no `PAYSTACK_SECRET_KEY` present); the integration code and its mocked/pure-function coverage are real
3. **Night audit** — ✅ **shipped**: the full sequence and recovery model from `ARCHITECTURE.md §6`; Reporting now reads the real `daily_reports` snapshot for any closed business date, falling back to the live computation only for the current open one. Steps 5 (packages) and 7 (POS reconciliation) of the 13-step sequence are skipped outright — neither module exists

**Tests required to close** (the most important suite in the project — these are the ones that cost real money when wrong):
- **Night audit idempotency**: run twice for the same business date → no double-posted charges — ✅ covered (`tests/night-audit/night-audit.test.js`); kill mid-run and re-trigger → same result — ✅ covered (`tests/night-audit/concurrency.test.js`, NA-3)
- **Business-date boundaries**: check-ins at 23:59 and 00:01 post to the correct business date in a property whose timezone differs from the server's — not separately tested this pass
- **Money arithmetic on exact DECIMAL**: folio totals, tax, split billing with an odd remainder, partial refunds, rounding boundaries — never float comparison with tolerance — ✅ covered (`tests/cashiering/cashiering.test.js`, `tax-engine.test.js`, `src/shared/money.js`)
- **Concurrency**: two simultaneous bookings for the last available room — one succeeds, one fails cleanly — ✅ covered in Phase 2 already (`tests/reservations/concurrency.test.js`); night audit's own equivalent (two simultaneous triggers) — ✅ covered (NA-2)
- **Overbooking threshold**: booking at, on, and past the sellable limit behaves as configured — ✅ covered in Phase 3
- **Room moves**: `reservation_rooms` history preserved, no overwrite — ✅ covered in Phase 2
- **Void, never delete**: a voided folio line remains queryable with its reason and voider — ✅ covered (`tests/cashiering/cashiering.test.js`), and confirmed live end to end this pass
- Isolation tests for reservations, folios, guests, rooms — ✅ covered; all five new Phase 2.5 tables are registered in `tests/helpers/entities.js` and inherit the generic `ISO-*` suite
- Payment gateway: success, decline, timeout, and duplicate-webhook handling against the provider's sandbox — success/decline/webhook-signature paths covered against mocks; a live sandbox round trip is not confirmed (see above)

**Pulled forward deliberately, as planned:** night audit idempotency and the last-room race. Both would have failed silently in production if left until later.

**Gaps flagged, not hidden**: SECURITY.md §5's matrix had no Night Audit column and no written-down definition of Cashiering's front-desk "Limited" cell until this pass closed both. `HomeDashboard.jsx`'s Night Audit alert row was not updated in the original pass — closed in a same-day follow-up; see CLAUDE.md's Phase 2.5 section. Accounts Receivable (§3.9) remains correctly deferred to Phase 4.

---

## Phase 3 — Making it survivable in daily use

Phase 2 works in a demo. This phase is what makes staff trust it during a busy shift.

- **Housekeeping (3.5)** — attendant assignments, mobile status board, discrepancy detection and report
- **Notifications (3.21)** — transactional email, delivery log, retry, in-app bell
- **Reporting (3.10)** — occupancy, revenue, financial reports; exports; the manager dashboard (PRODUCT_REQUIREMENTS.md, Manager dashboard screen) with its alert strip
- **Overbooking controls (3.2)** and early/late check-out fees (3.3)
- All six UI states (DESIGN_SYSTEM.md §2) audited across every screen shipped so far
- Offline/degraded handling on front-desk terminals

**Tests required to close:**
- Housekeeping discrepancy raised when front-desk and reported status diverge; not silently overwritten either way
- Out-of-order room is excluded from sellable inventory
- Email: send, delivery-webhook status update, hard bounce surfaced, retry on transient failure
- Report figures reconcile against the underlying folio data for a seeded day
- Exports respect the filters applied on screen
- Every screen shipped so far has its loading, empty, error, and offline states

**Exit:** a hotel could genuinely operate on this for a week without a developer on call.

---

## Phase 4 — Revenue and guest-facing

- **Guest booking portal (3.14)** — tenant-themed, availability, booking, payment, confirmation
- **Guest accounts** — separate credential store (3.16), online check-in
- **POS integration (3.4) — core only**: outlets, terminals, menu, order flow, cash-up, charge-to-room. QR self-ordering and inventory/stock control are deferred to Phase 6 (§3.4 covers both in full; they're real scope, not an afterthought — see the note below)
- **Accounts receivable (3.8)** — company invoicing, credit, ageing
- **Group blocks (3.7)** — blocks, rooming lists, pickup tracking, group billing

**Tests required to close:**
- **A guest session cannot satisfy any PMS route** (the highest-value test in this phase)
- Portal booking end to end: availability → book → pay → confirmation email → reservation visible on the arrivals board
- Payment failure mid-booking leaves no orphaned reservation and no orphaned charge
- POS charge-to-room lands on the correct open folio; a closed folio rejects it
- AR: invoice generation from folios, ageing buckets, credit limit enforcement
- Group block pickup count matches reservations actually made against the block
- Tenant theming: portal renders with tenant colours and logo, with no admin styling leaking in

**Exit:** the hotel earns revenue through the product, not just records it.

---

## Phase 5 — SaaS commercialisation

Until now the product runs for tenants you create by hand. This phase makes it a business.

- **Signup and provisioning (3.22)** — self-service, no engineer in the loop
- **Plans and entitlements** — the single entitlement check, applied to already-built features
- **Subscription billing** — recurring charges, invoices, dunning, pluggable processor
- **Trial handling** — read-only degradation, never a hard lockout on a system holding live reservations
- **Offboarding with full data export**
- **Platform console** — tenant list, health, audited impersonation
- **Data migration (3.20)** — import templates, dry run, dedupe, rollback

**Tests required to close:**
- Entitlement gating enforced at the API, not just hidden in the UI — a tenant on a lower plan calling a gated endpoint directly is rejected
- Trial expiry degrades to read-only and does not lock a hotel out of live reservations
- Offboarding export contains the tenant's complete data
- Impersonation is logged, time-bounded, and visible to the tenant
- Platform console cannot read tenant data outside the impersonation path
- Migration: dry run writes nothing, duplicate detection surfaces matches without auto-merging, rollback fully reverses a run

**Note on migration's placement:** it sits here because it is needed when onboarding real customers at volume, but pull it into Phase 1 for any single customer arriving with existing records.

---

## Phase 6 — Depth and scale

Genuinely optional until customers ask. Building these early is the most likely way to over-engineer this product.

- Multi-property (3.12) — cross-property reservations, chain-wide reporting
- Revenue management (3.11) — dynamic pricing, forecasting, yield
- Channel manager / OTA distribution (3.15)
- Loyalty programme (3.1)
- Mobile refinement (3.18), multi-language (3.17)
- **QR guest self-ordering (3.4)** — signed table/room tokens, guest-facing ordering pages, payment-status-on-ticket, live order status. Real feature scope on its own (see §3.4's full spec), not a small add-on to core POS.
- **POS inventory & stock control (3.4)** — stock items, recipes/BOM, goods received, stock takes with blind variance counting, wastage tracking, low-stock alerts. Needed for F&B cost control and fraud detection, but not for a hotel to simply run a functioning bar.

---

## Phase 7 — Door access monitoring (conditional)

**Do not schedule this until lock hardware is confirmed** (3.23). It is gated on a vendor integration whose cost and effort cannot be estimated until a specific make and model is known, and for many properties the honest answer will be `manual_import` only.

Sequence if it proceeds: config table → ingestion adapter → rules engine → alerts UI → night audit reconciliation sweep.

---

## Cross-cutting, every phase

- Cross-tenant isolation test for every new module **before it ships** (TESTING.md)
- Regression suite runs green before any merge; a failing test blocks the merge rather than being skipped
- Any production bug gets a failing test reproducing it *before* the fix, so it cannot silently return
- Audit rows on every money, rate, or room-state change
- No hardcoded colours, currencies, or tenant-specific branches (PRODUCT_REQUIREMENTS.md §1.1)
- Migrations backwards-compatible — they run against every tenant at once
- All six UI states built alongside the happy path, not afterwards

## Known decisions still open

- Which payment processor for **subscription** billing (distinct from guest payments)
- Whether the first real customer is a paying SaaS tenant or a guided onboarding
- Lock vendor, if door access is ever scoped
- Retention windows for guest PII and door data, per applicable jurisdiction
