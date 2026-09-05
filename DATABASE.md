# DATABASE.md

Companion to `AGENT.md` and `ARCHITECTURE.md`. The reference schema, entity scoping in practice, uniqueness rules, and record lifecycle. Read `ARCHITECTURE.md` §3 (entity scoping) first — this file is where that classification becomes actual tables.

## 1. Schema by module

Reference schema for every module. Column lists are indicative rather than exhaustive — timestamps (`created_at`, `updated_at`) are assumed on every table and omitted below for brevity. **Every tenant-owned table carries `tenant_id`; every operational table also carries `property_id`** (this file's own entity-scoping section, and ARCHITECTURE.md §3), likewise omitted from each line below rather than repeated 60 times.

**Tenancy & platform (3.22)**

| Table | Key columns | Notes |
|---|---|---|
| `tenants` | name, slug, status (trial/active/suspended/offboarding), plan_id, trial_ends_at | The paying customer |
| `plans` | code, name, price, billing_interval, limits (JSON: properties, rooms, users) | |
| `plan_entitlements` | plan_id, feature_key, enabled | One entitlement check reads this (3.22) |
| `subscriptions` | tenant_id, plan_id, status, current_period_start/end, payment_method_ref | Never store card data — provider token only |
| `subscription_invoices` | subscription_id, amount, currency, status, issued_at, paid_at, provider_ref | Planmsys→tenant billing. Distinct from `ar_invoices` |
| `usage_records` | tenant_id, metric, quantity, period_start/end | For usage-based plans |

**Identity & access (3.4)**

| Table | Key columns | Notes |
|---|---|---|
| `users` | tenant_id, email, password_hash, first_name, last_name, status, last_login_at, mfa_enabled | Hotel staff. Deactivate, never delete — audit rows reference this. `mfa_secret` is deprecated as of the auth-credentials migration — superseded by `mfa_devices`, kept temporarily as metadata-only per the no-drop-in-the-same-release rule below |
| `user_property_access` | user_id, property_id, role | A user may work across properties; role is per property |
| `roles` / `permissions` / `role_permissions` | code, name, permission keys | Seeded reference data |
| `sessions` | tenant_id, user_id, refresh_token_hash, expires_at, revoked_at, device_label, ip | Revocable — dismissal must invalidate immediately (PRODUCT_REQUIREMENTS.md §3.16). Reaches `users` through (tenant_id, user_id), never a bare `user_id` — this rule is enforced generically for any table carrying `user_id` (see SECURITY.md §2) |
| `mfa_devices` | tenant_id, user_id, type, secret, confirmed_at | UNIQUE(tenant_id, user_id, type) — one device per type per user. Replacing a device is remove-then-enrol, accepting a brief window without that factor, in exchange for never having two secrets of ambiguous precedence for the same type |
| `password_resets` | tenant_id, user_id, token_hash, expires_at, used_at | Single-use, enforced as a conditional `UPDATE ... WHERE used_at IS NULL` with an affected-row check — never read-then-write, which would race |
| `user_invitations` | tenant_id, property_id, email, role, invited_by_user_id, token_hash, expires_at, accepted_at | **PROPERTY_SCOPED, not tenant-scoped.** The property and role are fixed by whoever sends the invitation, not chosen by the invitee on acceptance — letting the invitee pick their own scope is a privilege-escalation path, not a minor omission (SECURITY.md §4: role is never global). Acceptance writes the corresponding `user_property_access` row. `invited_by_user_id` satisfies the audit requirement on permission grants (SECURITY.md §1.1) |
| `platform_users` | email, password_hash, mfa_secret | Planmsys staff. **Separate table — no tenant_id** |
| `impersonation_sessions` | platform_user_id, tenant_id, reason, started_at, ended_at | The audited access path (SECURITY.md §2) |
| `guest_accounts` | property_id, guest_id, email, password_hash | **Separate from `users`** — a guest session must never satisfy a PMS route |

**Property & configuration (3.19)**

| Table | Key columns | Notes |
|---|---|---|
| `properties` | tenant_id, name, address, timezone, base_currency, current_business_date, logo_url, theme (JSON), scheduled_checkout_time, early_checkout_cutoff_time, early_departure_fee, late_checkout_fee | `current_business_date` drives night audit (3.10). The four checkout-policy columns are PLAN.md Phase 3 additions — Phase 2's `computeEarlyLateFee` (3.3) had no property-level configuration source and required every check-out request to supply its own cutoffs/fees explicitly; check-out now defaults to these when the caller does not override them. All four are set through the same `PATCH /properties/:id` Phase 1 already built (it passes the request body through as arbitrary column updates), no new endpoint needed. |
| `tenant_domains` | tenant_id, domain, verified_at | Custom-domain login resolution (PRODUCT_REQUIREMENTS.md §3.16) — a second hop off the same `Host`-header resolution used for subdomains. `domain` is globally unique (bootstrap-lookup exception, ARCHITECTURE.md §3), since two tenants cannot register the same domain |
| `room_types` | code, name, description, default_occupancy, base_rate, photos (JSON) | |
| `rooms` | room_number, floor, room_type_id, front_desk_status, housekeeping_reported_status, housekeeping_occupancy_observed, has_discrepancy, connecting_room_id | Two status columns by design (3.6) — `front_desk_status`/`housekeeping_reported_status` were written by Phase 1 with a "Phase 2 territory" note but never actually updated by Phase 2's check-in/check-out; PLAN.md Phase 3 fixed that (both now transition on check-in/check-out/room-move) and added `housekeeping_occupancy_observed`, the housekeeper's own occupancy reading compared against `front_desk_status` to raise a `housekeeping_discrepancies` row. |
| `room_type_inventory` | room_type_id, stay_date, rooms_sold, overbooking_threshold_pct | Sellable ≠ physical (3.2). No stored `physical_rooms` column (PLAN.md Phase 2 built this table) — physical availability is computed live via `src/shared/room-availability.js` (`COUNT(rooms WHERE room_type_id = X AND status = 'active')`, minus out-of-order and discrepant rooms) at lock time, never cached, so a room's status change is reflected in every future date immediately with nothing to keep in sync. PLAN.md Phase 2's own flagged gap here — no way to schedule a *future* out-of-service window — was closed in Phase 3 by `out_of_order_periods` below. `rooms_sold` is the row this table actually owns: an atomic counter under `SELECT ... FOR UPDATE` (ARCHITECTURE.md §5's last-room race). `PUT /room-types/:roomTypeId/inventory/:stayDate` (Phase 3) is the endpoint that actually sets `overbooking_threshold_pct` — Phase 2 built the column with only its 100% schema default and no way to change it. |
| `rate_codes` | code, description, base_rate, currency, valid_from, valid_to | |
| `rate_calendar` | rate_code_id, room_type_id, stay_date, rate | Date-level overrides |
| `packages` | code, name, inclusions (JSON), price_adjustment | |
| `taxes` | tax_code, name, rate, applies_to, effective_from, effective_to, inclusive_or_exclusive, calculation_method, priority, is_compound, rounding_method, jurisdiction | Effective-dated — never rewrites historical folios. Full column set per ARCHITECTURE.md §12.1; a charge always calculates against the tax version effective on its `business_date`, not the current rate |
| `market_segments` / `booking_sources` | code, name | Reference data; needed from day one or historical reporting can't be rebuilt |
| `cancellation_policies` | name, cutoff_hours, fee_type, fee_amount | |

**Guests & CRM (3.1)**

| Table | Key columns | Notes |
|---|---|---|
| `guests` | tenant_id, first_name, last_name, email, phone, nationality, id_document_ref, company_profile_id | **TENANT_SCOPED, not property-scoped** (ARCHITECTURE.md §3). Guest identity is one record across every property the tenant runs. PII — encrypted at rest (SECURITY.md §1) |
| `guest_properties` | tenant_id, guest_id, property_id, first_seen_at, last_seen_at, is_vip, vip_tier, preferences (JSON) | The guest-property *relationship* — VIP status, preferences, and stay history are commonly property-specific even though the guest identity isn't. A guest who is VIP at the flagship property isn't automatically VIP everywhere. |
| `company_profiles` | name, type (company/travel_agent/source), billing_email, credit_limit, payment_terms_days | Drives AR (3.9) |
| `loyalty_accounts` | guest_id, tier, points_balance | |
| `loyalty_transactions` | loyalty_account_id, points, reason, reservation_id | |

**Reservations & front desk (3.2, 3.3)**

| Table | Key columns | Notes |
|---|---|---|
| `reservations` | guest_id, group_block_id, rate_code_id, market_segment_id, booking_source_id, arrival_date, departure_date, adults, children, status, confirmation_number, checked_in_at, checked_out_at, cancellation_policy_id | `guest_id` references the tenant-level `guests` row regardless of which property this reservation is for — the guest's identity doesn't change per property. status: waitlisted/confirmed/checked_in/checked_out/cancelled/no_show |
| `reservation_rooms` | reservation_id, room_id, effective_from, effective_to | Room moves keep history — never overwrite (ARCHITECTURE.md §3 covers the scoping rule; this table is the mechanism) |
| `reservation_daily_rates` | reservation_id, stay_date, rate, currency | Rate can vary per night; storing it prevents retroactive rate changes altering a booked stay |
| `reservation_notes` | reservation_id, note, user_id | Special requests, front-desk notes |
| `group_blocks` | block_name, company_profile_id, start_date, end_date, rooms_blocked, cutoff_date | |
| `group_block_rooms` | group_block_id, room_type_id, stay_date, rooms_blocked, rooms_picked_up | Drives the pickup progress bar (PRODUCT_REQUIREMENTS.md, Back-office screens) |
| `waitlist_entries` | guest_id, room_type_id, requested_dates, status | |
| `registration_cards` | reservation_id, signature_ref, signed_at | Digital reg card |

**Cashiering & AR (3.5, 3.9)** — PLAN.md Phase 2.5 built the real ledger and gateway rows below (`folios` through `currency_rates`); Accounts Receivable (`ar_accounts` through `ar_payments`) is real §3.9 scope but correctly deferred to Phase 4, per PLAN.md's own phase list, and remains unbuilt.

| Table | Key columns | Notes |
|---|---|---|
| `folios` | reservation_id, folio_number, billed_to, company_profile_id, currency, status | Built. `billed_to` is a free-text label this pass, not yet a `company_profile_id` FK — no company-profile concept exists until AR (Phase 4) lands. Multiple folios per reservation for split billing (`openAdditionalFolio`) |
| `folio_line_items` | folio_id, type, description, amount, currency, tax_amount, payment_method, business_date, posted_by_user_id, voided_at, voided_by_user_id, void_reason | Built. **Void, never delete**, verified live in this pass. type: room_charge/tax/pos_charge/payment/refund/adjustment. `folios.balance` is never written directly — always `recomputeFolioBalance`, the sum of every non-voided line |
| `payments` | tenant_id, property_id, folio_id, idempotency_key, provider, provider_payment_id, provider_reference, amount, currency, status, failure_code, failure_reason, authorized_at, captured_at, failed_at, expired_at, parent_payment_id | Built for `cash` (synchronous) and `paystack` (real sandbox adapter — HMAC-SHA512 webhook verification, refunds); `flutterwave` deliberately not wired (no sandbox credentials), `provider` is a free string so adding it needs no schema change. `status` follows the state machine in ARCHITECTURE.md §7. `parent_payment_id` links a refund back to what it refunds, confirmed live in this pass. `idempotency_key` unique per tenant+operation (DATABASE.md §2) |
| `payment_webhook_events` | provider, provider_event_id, payload (JSON), verified, processed_at, related_payment_id | Built. PLATFORM_SCOPED with nullable tenant/property attribution, resolved via a raw post-persist lookup — the same "arrives before any tenant is known" shape `auth_events`/`idempotency_keys` already established. Persisted separately from `payments` — the record of what the provider actually sent, independent of what the payment row currently says (ARCHITECTURE.md §7). Unique on (provider, provider_event_id) for dedupe |
| `idempotency_keys` | tenant_id, operation_type, key_value, request_hash, response_snapshot (JSON), created_at, expires_at | Generic idempotency store used by every financial-mutation endpoint (ARCHITECTURE.md §7), not just payments. `request_hash` catches same-key-different-parameters misuse — confirmed live this pass (a reused key with different charge amounts correctly returns `409 CONFLICT_IDEMPOTENCY_KEY_REUSE`) |
| `currency_rates` | from_currency, to_currency, rate, source (`automated`/`manual`), entered_by_user_id, locked_at | Not built — no multi-currency folio exists yet to lock a rate for; every folio this pass is single-currency, matching its reservation |
| `ar_accounts` | company_profile_id, credit_limit, current_balance | Not built — Accounts Receivable (§3.9) is Phase 4 scope |
| `ar_invoices` | ar_account_id, invoice_number, amount, currency, issued_at, due_at, status | Not built — same reasoning |
| `ar_invoice_lines` | ar_invoice_id, folio_id, amount | Not built — same reasoning |
| `ar_payments` | ar_account_id, amount, received_at, applied_to_invoice_id | Not built — same reasoning |

**Housekeeping (3.6)** — PLAN.md Phase 3 built exactly the tables its own bullet list and test gate name (attendant assignments, mobile status board, discrepancy detection/report, and the out-of-order mechanism its test gate requires); `room_inspections`, `maintenance_requests`, `lost_and_found`, and `minibar_items`/`minibar_consumption` are real §3.6 scope but not named in that bullet list, so they remain unbuilt rows here, not silently dropped.

| Table | Key columns | Notes |
|---|---|---|
| `housekeeping_assignments` | tenant_id, property_id, room_id, attendant_user_id, business_date, status, started_at, completed_at | Built. UNIQUE(property_id, room_id, business_date) — one attendant per room per day; reassignment is an UPDATE, not a second row. |
| `housekeeping_discrepancies` | tenant_id, property_id, room_id, business_date, front_desk_status, housekeeping_status, raised_at, resolved_at, resolved_by_user_id, resolution_note | Built in place of a generic `room_status_history` log — a first-class RECORD per PRODUCT_REQUIREMENTS.md's own "dedicated screen ... resolve action" language, not an append-only feed a screen would have to summarise. `rooms.has_discrepancy` (Phase 1) stays the fast live flag, kept in sync by the same write. |
| `rooms.housekeeping_occupancy_observed` | (column, not a table) | Built — added to `rooms` in this pass. The housekeeper's own physical occupancy observation, compared against `rooms.front_desk_status` to detect a discrepancy; the two Phase 1 status columns (`front_desk_status` occupancy, `housekeeping_reported_status` cleanliness) answer different questions and were never directly comparable. |
| `out_of_order_periods` | tenant_id, property_id, room_id, type (ooo/oos), reason, start_date, end_date, created_by_user_id | Built — the date-ranged scheduling mechanism `room_type_inventory`'s own Phase 2 migration header flagged as missing; PLAN.md Phase 3's own test gate ("out-of-order room excluded from sellable inventory") is written against this table via `src/shared/room-availability.js`. |
| `room_inspections` | room_id, inspector_user_id, passed, notes, inspected_at | Not built — real §3.6 scope, not in PLAN.md Phase 3's bullet list. |
| `maintenance_requests` | room_id, description, priority, status, raised_by, resolved_at | Not built — same reasoning. |
| `lost_and_found` | property_id, description, found_in_room_id, found_at, status, guest_id | Not built — same reasoning. |
| `minibar_items` / `minibar_consumption` | item, price / reservation_id, item_id, quantity, business_date | Not built — real §3.6 scope, not in PLAN.md Phase 3's bullet list. `folio_line_items` (Cashiering, Phase 2.5) now exists to post against, but the minibar module itself still doesn't. |

**Night audit & reporting (3.10, 3.11)** — PLAN.md Phase 2.5 built Night Audit for real, closing the gap Phase 3's Reporting pass had flagged: `night_audit_runs` and `daily_reports` are both built, computed from the real `folio_line_items` ledger Phase 2.5 also built. Reporting (`src/modules/reporting/index.js`) now reads the real `daily_reports` snapshot for any business date Night Audit has already closed, falling back to the original LIVE computation (`room_type_inventory`/`reservation_daily_rates`) only for a date with no snapshot yet — each returned figure carries `audited: true/false` so a caller can tell which one it's looking at. `report_schedules` remains unbuilt — scheduled delivery needs a notification-settings screen and a maturer report catalogue neither of which exists yet.

| Table | Key columns | Notes |
|---|---|---|
| `night_audit_runs` | property_id, business_date, status, worker_id, heartbeat_at, started_at, completed_at, failed_at, error, run_by_user_id | Built. `status`: READY/RUNNING/COMPLETED/FAILED/STALE/RECOVERABLE (ARCHITECTURE.md §6). A run row is claimed via `UPDATE ... WHERE status='FAILED'` with an affected-row check, never a fresh insert, under UNIQUE(property_id, business_date); a stale RUNNING row is recovered by checking reality (does a `daily_reports` row and an advanced business date already exist), not by trusting the row's own status. No background heartbeat-sweeping monitor — recovery is evaluated lazily on the next trigger, a deliberate, flagged reduction. |
| `daily_reports` | property_id, business_date, room_revenue, pos_revenue, payments_collected, occupancy_pct, adr, revpar | Built, computed from the real `folio_line_items` ledger. Reporting reads this snapshot for any closed business date and falls back to the original live computation only for the current, still-open date. |
| `outbox_events` | id, tenant_id, property_id, event_type, aggregate_type, aggregate_id, payload (JSON), status (`pending`/`processing`/`sent`/`failed`), attempt_count, last_error, created_at, processed_at | Built. TENANT_SCOPED (not PROPERTY_SCOPED — `property_id` is attribution, following `idempotency_keys`' own precedent; see that table's own migration header). Written in the same transaction as the business change it describes (ARCHITECTURE.md §13); dispatched afterwards by `src/jobs/outbox-dispatcher.js`. |
| `report_schedules` | report_key, cron, recipients (JSON), format, last_run_at | Not built — needs a notification-settings screen and Reporting's own catalogue to mature first. |

**Notifications (3.21)** — built: the outbox pipeline above, a pluggable email adapter (a `console` adapter is the default this pass — no provider credentials exist in this environment), the admin template editor, the delivery log with a resend action, and the in-app bell. Wired to four events this pass (`reservation.confirmed`, `reservation.cancelled`, `guest.checked_in`, `guest.checked_out`) — the only real guest-facing lifecycle events any module emits yet.

| Table | Key columns | Notes |
|---|---|---|
| `email_templates` | tenant_id, property_id, template_key, locale, subject, body_html | Built. PROPERTY_SCOPED — two properties in the same tenant can want different branding for the same key. UNIQUE(property_id, template_key, locale). A key with no configured row falls back to a built-in default body rather than silently dropping the send. |
| `notification_log` | tenant_id, property_id, recipient_email, template_key, channel, status, provider_ref, failed_reason, reservation_id, sent_at, delivered_at | Built. The answer to "the guest never got it" (3.21) — indexed on recipient per this file's own indexing note. |
| `in_app_notifications` | tenant_id, user_id, type, payload (JSON), read_at | Built. TENANT_SCOPED (not PROPERTY_SCOPED — a notification belongs to a staff member, not a property; see that table's own migration header). Written directly inside the triggering transaction, NOT through the outbox — an internal DB row is not the external-call latency problem §13's pattern exists to decouple. |

**POS & integrations (3.15)**

| Table | Key columns | Notes |
|---|---|---|
| `pos_outlets` | property_id, name, type (bar/restaurant) | |
| `pos_shifts` | terminal_id, user_id, opening_float, counted_cash, expected_cash, variance, opened_at, closed_at | Blind cash-up — counted before expected is revealed |
| `pos_terminals` | outlet_id, device_ref, supports_contactless | Terminal count varies per tenant — never hardcode |
| `pos_orders` | outlet_id, terminal_id, opened_by_user_id, table_label, opened_at, closed_at, status, folio_id, settlement_method, tip_amount, service_charge | `folio_id` set when charged to a room |
| `pos_order_items` | pos_order_id, item_id, quantity, unit_price, modifiers (JSON), voided_at, void_reason, voided_by_user_id | |
| `pos_menu_items` | outlet_id, name, price, category, is_available, cost_price, photo_url |
| `pos_menu_item_components` | menu_item_id, stock_item_id, quantity | Recipe/BOM — selling one cocktail deducts each component (3.4) |
| `pos_order_tokens` | outlet_id, type (`table`/`room`), table_label, room_id, token_hash, active, rotated_at | The signed QR token. Never encode a bare table number — that lets anyone order against any table or room |
| `pos_guest_orders` | pos_order_id, token_id, guest_contact, payment_status (`paid`/`charged_to_room`/`unpaid`), accepted_at, rejected_reason, status | Guest-placed orders; payment status shown on the kitchen/bar ticket |
| `stock_items` | outlet_id, name, unit, purchase_cost, supplier, reorder_level, current_quantity | |
| `stock_movements` | stock_item_id, type (`received`/`sold`/`wastage`/`transfer`/`count_adjustment`), quantity, reason, user_id, occurred_at | Append-only movement ledger — the audit trail for stock |
| `stock_takes` | outlet_id, counted_at, counted_by_user_id, status | |
| `stock_take_lines` | stock_take_id, stock_item_id, counted_quantity, theoretical_quantity, variance | Variance is the pilferage signal | |
| `integration_configs` | tenant_id, property_id, integration_key, config (JSON), enabled | Gateway/channel-manager settings as data, not code |

**Migration & audit (3.20, 4.1)**

| Table | Key columns | Notes |
|---|---|---|
| `import_runs` | tenant_id, entity_type, file_ref, status, rows_total, rows_created, rows_skipped, run_by, completed_at | Rollback unit |
| `import_row_errors` | import_run_id, row_number, column, message | Drives the dry-run error table (PRODUCT_REQUIREMENTS.md, Data Migration screens) |
| `imported_record_map` | import_run_id, entity_type, entity_id | Enables wholesale rollback |
| `audit_log` | entity_type, entity_id, action, user_id, before_state (JSON), after_state (JSON), occurred_at | Every money/rate/room-state change (SECURITY.md §6) |
| `auth_events` | user_id, event_type, ip, user_agent, occurred_at | Logins, failures, lockouts, MFA, impersonation (3.4) |

**Door access — PHASE 2 (3.23)**

| Table | Key columns | Notes |
|---|---|---|
| `lock_system_config` | property_id, adapter (`none`/`hiread_prousb`/`hiread_elock`/`hiread_tthotel`/`generic_csv`), tier, ingestion_mode, credentials (JSON, encrypted), gateway_installed, supports_realtime, last_import_at, last_connection_test_at | Admin-selectable (PRODUCT_REQUIREMENTS.md, Setup & Configuration screens). Hardware upgrade = row update, never a deploy. Credentials encrypted at rest like any other secret (SECURITY.md §1.1) |
| `door_access_events` | room_id, lock_system, external_event_id, card_id, card_type, staff_user_id, reservation_id, result, opened_at, ingested_at, is_retrospective | **Append-only.** Unique on (lock_system, external_event_id) |
| `access_alerts` | room_id, rule, severity, evidence (JSON), status, acknowledged_by, resolved_by, resolution_reason, business_date | Resolve with reason; never delete |

**Indexing notes.** Every table needs an index leading with `tenant_id` (and `property_id` where present), since every query filters on it — a non-tenant-leading index is close to useless here. Beyond that: `reservations` on (property_id, arrival_date, status) for the arrivals board, `folio_line_items` on (folio_id, business_date), `door_access_events` on (property_id, room_id, opened_at), and `notification_log` on recipient for the support lookup.


### 1.1 Guest identity vs guest-property relationship

See the `guests` / `guest_properties` split above. This exists because a tenant's central guest database (PRODUCT_REQUIREMENTS.md §3.13) means one guest identity shared across every property — but VIP status, preferences, and "first seen" are commonly true at one property and not another. Splitting identity from relationship is what makes both true at once.


## 2. Unique constraints (explicit, not implied)

Every constraint below must exist at the database level — not just checked in application code, which is a race condition waiting to happen (ARCHITECTURE.md §5).

```
tenants:              UNIQUE(slug)
properties:           UNIQUE(tenant_id, slug)
rooms:                UNIQUE(property_id, room_number)
room_types:            UNIQUE(property_id, code)
rate_codes:            UNIQUE(property_id, code)
reservations:          UNIQUE(tenant_id, confirmation_number)
folios:                UNIQUE(reservation_id, folio_number)
pos_terminals:         UNIQUE(outlet_id, device_ref)
pos_order_tokens:      UNIQUE(token_hash)
door_access_events:    UNIQUE(lock_system, external_event_id)
users:                 UNIQUE(tenant_id, email)
guest_accounts:        UNIQUE(property_id, email)
platform_users:        UNIQUE(email)
user_property_access:  UNIQUE(user_id, property_id)
guest_properties:      UNIQUE(guest_id, property_id)
idempotency_keys:      UNIQUE(tenant_id, operation_type, key_value)
payment_webhook_events: UNIQUE(provider, provider_event_id)
taxes:                 UNIQUE(property_id, tax_code, effective_from)
room_types:            UNIQUE(tenant_id, property_id, id)  -- parent key for 3-column composite FKs
rate_codes:            UNIQUE(tenant_id, property_id, id)  -- same purpose, see ARCHITECTURE.md §3 note below
```

**The 3-column composite FK pattern.** Phase 0 only ever needed 2-column parent keys (`(tenant_id, id)`) because every cross-table reference went TENANT_SCOPED → PROPERTY_SCOPED. The first time one PROPERTY_SCOPED table references *another* PROPERTY_SCOPED table — `rooms.room_type_id → room_types`, `rate_calendar.room_type_id/rate_code_id → room_types/rate_codes` — a 2-column key isn't enough: it would let a room at Property A reference a room type belonging to Property B in the *same* tenant, which ARCHITECTURE.md §3 explicitly rules out. The referencing FK must be the full 3-column composite — `(tenant_id, property_id, room_type_id)` against `room_types(tenant_id, property_id, id)` — and the referenced table needs that composite declared as its own unique constraint (added above) for the FK to be possible at all. Any future PROPERTY_SCOPED-to-PROPERTY_SCOPED reference follows this same pattern.

A migration adding a new table checks this list first — if the table represents an entity that should be unique per tenant or per property (a code, a slug, a device reference), the constraint is added in the same migration that creates the table, not retrofitted after a duplicate-data incident.

## 3. Soft-delete and lifecycle rules

"Void, never delete" (ARCHITECTURE.md, SECURITY.md) is the rule for financial records specifically. Everything else still needs an explicit lifecycle — a table with no status column and no delete path is a table nobody thought about.

| Entity | Lifecycle states | Never hard-deleted because |
|---|---|---|
| `rooms` | active → out_of_service → archived | Historical reservations reference the room; deleting it orphans them |
| `room_types`, `rate_codes` | active → archived | Historical reservations and rate history reference them |
| `taxes` | no status column — `effective_to` alone is the lifecycle. A tax version "ends" by having `effective_to` set, never by a status flag or a row edit | Historical folio tax lines must recompute against the version effective on their `business_date` (ARCHITECTURE.md §12.1) — a status column inviting an in-place edit would defeat that reproducibility guarantee outright |
| `pos_menu_items` | active → archived (via `is_available` for transient stock-outs, a separate concept) | Historical order lines reference them |
| `users` | active → inactive | Audit log entries reference `user_id` (SECURITY.md §5) |
| `properties` | active → suspended → archived | Tenant history, reporting, and every property-scoped table reference it |
| `guests` | active → merged (points to the surviving record) → anonymised | Reservation history; see the GDPR/NDPA note below |
| `company_profiles` | active → inactive | AR history references them |

Standard states, applied wherever a table needs them: `active`, `inactive`/`archived`. Deviate only where the domain genuinely needs a different vocabulary (`out_of_service` for a room reads better than a generic `inactive`).

**Guest data specifically**: guest records must not be physically deleted where doing so would break a legally or financially required historical record (a folio references the guest who was billed). Where a deletion/erasure request must be honoured, anonymise the guest's personal fields in place rather than deleting the row — the reservation and folio history stays intact and auditable, the personal identifiers don't.
