# PRODUCT_REQUIREMENTS.md

Companion to `AGENT.md`. Full product scope and feature specification for every module — what the product does, not how it's built (see `ARCHITECTURE.md`) or in what order (see `PLAN.md`).

## 1. What this product is

Lodgekeep is a **multi-tenant SaaS** Hotel Property Management System (PMS) — a lighter, faster, cloud-native alternative to Oracle OPERA PMS, sold as a subscription product to many hotels rather than built for one. The target market is independent hotels and small chains, initially in Nigeria and West Africa, with the architecture kept region-neutral so other markets are a configuration exercise rather than a rewrite.

There is no single reference customer. Where an example hotel appears anywhere in this document it is illustrative only — **no requirement should ever be built in a way that only works for one property, one country, or one currency.**

The product combines:

- A full front-office / back-office PMS (reservations, front desk, cashiering, housekeeping, night audit, reporting)
- An integrated POS system for bar/restaurant, with hardware terminals
- A guest-facing online booking portal, white-labelled per tenant (custom branding + the hotel's own domain)
- Payments through a pluggable gateway layer — Paystack (cards/digital) and Flutterwave (NQR scan-to-pay) for the launch market, behind an interface that accepts additional processors without touching the modules that call it

### 1.1 SaaS implications — read before building anything

These follow from being a product rather than a project, and they constrain nearly every decision below:

- **Tenant isolation is the highest-severity concern in the system.** One hotel seeing another hotel's guests, rates, or revenue is a business-ending bug, worse than any outage. Every query is scoped by tenant, enforced at the data-access layer rather than trusted to individual queries (see 4.2).
- **`tenant_id` and `property_id` are distinct.** A tenant is the paying customer (a hotel group or independent hotel); a property is a physical hotel. One tenant may own several properties. Do not conflate them — a single-property customer today may add a second next year, and retrofitting that split is expensive.
- **No per-customer forks or hardcoded customer logic.** Anything that varies between hotels — branding, tax rules, rate structures, currency, room types, email templates, enabled features — is **configuration data, not code**. If you find yourself writing `if (tenant === 'goldenland')`, the design is wrong.
- **Self-service onboarding is the goal.** A new hotel should be able to sign up, configure, and go live without an engineer. The setup module (3.19) is the product's front door, not an internal admin tool.
- **Schema changes affect every customer at once.** Migrations must be backwards-compatible and safe to run against live tenant data — no destructive column drops in the same release that stops writing to them.
- **Every tenant sits at a different point in time.** One property's night audit has run; another's hasn't. One is mid-check-in rush; another is closed for renovation. Never assume a global "current state" — business date, and everything derived from it, is per property (3.10).
- **Noisy-neighbour protection.** A large hotel running a heavy report must not degrade service for everyone else. Long-running work (reports, exports, imports, scheduled sends) goes to background jobs with per-tenant limits, not inline request handling.
- **Feature entitlements by plan.** Multi-property, advanced revenue management, channel manager integration, and door access monitoring are natural paid tiers. Build the entitlement check in early — retrofitting gating across a mature codebase is painful.
- **Nothing is hardcoded to one market.** Currency, tax model, date and number formatting, language, timezone, and payment gateway are all per-tenant configuration. The launch market shapes which adapters get written first, never what the core assumes. Specifically: never hardcode a currency symbol or a single tax rate, never assume one country's tax model, and never assume the platform's timezone equals the property's (3.10 depends on this).

The OPERA-standard module structure is used deliberately so front-office staff already trained on OPERA (or similar PMS) need minimal retraining. The 10 core modules staff expect are: **Profiles, Reservations, Front Desk, Cashiering, Housekeeping, Rooms Management, Group Blocks, Accounts Receivable, Night Audit, Reporting.** Treat these as the spine of the domain model — every feature below hangs off one of these.

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js + Express | REST API, modular service architecture — one module folder per PMS module |
| Database | MySQL | Relational schema; use proper foreign keys between guests, reservations, folios, rooms, and properties — this is transactional, money-touching data, so favour normalized tables and DB-level constraints over denormalized documents |
| Query layer | Knex.js | Query builder, not a full ORM — gives parameterized queries, transactions, and migration files without fighting the joins night audit/reporting need. Migrations live in `/backend/migrations` and are checked into the repo. |
| Frontend | React (responsive web) | Must work on desktop, tablet, and front-desk terminals — design mobile/tablet-first for front desk and housekeeping screens |
| Auth | JWT / session-based, RBAC — three separate identity populations (staff, guests, platform staff), see 3.4 | Token carries `tenant_id` + `property_id` scope. Roles: front desk, cashier, housekeeping, manager, admin, super-admin (tenant-wide), plus Planmsys platform staff (see 4.2) |
| Payments | Pluggable gateway layer; Paystack (cards/digital) and Flutterwave (NQR) as the launch adapters | Gateway is per-tenant configuration. Modules call the payment interface, never a provider SDK directly, so a new market means a new adapter rather than edits across the codebase. Never store raw card data — tokenised processing only. |
| POS integration | Custom POS terminal API + hardware terminals (bar/restaurant) | Terminal count varies per customer — never hardcode. Terminals must be NFC/contactless-capable (tap-to-pay), not chip/swipe-only — confirm this at procurement time with the Flutterwave/Paystack POS hardware SKU ordered, since it's a hardware spec, not something the integration layer can add later. |
| Hosting | Cloud (Planmsys infra) | Shared multi-tenant deployment, single codebase, one database with tenant-scoped rows. No on-prem, no per-customer instances |
| Background jobs | Queue worker (night audit, reports, exports, imports, email sends) | Per-tenant concurrency limits so one large customer can't starve the rest |

Do not introduce a different backend language/framework, ORM, or database without discussing it — the stack above is fixed for the product, and every tenant runs on the same codebase.

## 2. Domain modules and feature scope

**This section describes the product's full scope, not what to build first.** Every module below exists somewhere on the roadmap; very few belong in the first working version. Before starting implementation work, read `PLAN.md`, which sequences these modules into phases and states explicitly what is MVP, what is Phase 1.5/2, and what is deferred. Treat this section as the reference for *what a module means when its phase arrives*, not as a build list to work through top to bottom.

When implementing or reviewing a feature, map it to one of these modules. Each maps to a service + set of routes + a related group of MySQL tables; keep module boundaries clean (avoid one giant `hotel` table doing everything — normalize into per-module tables with foreign keys, e.g. `reservations`, `reservation_rooms`, `folios`, `folio_line_items`).

### 3.1 Profiles (Guest CRM)
- Guest history, stay records, preferences
- VIP guest flags and handling
- Loyalty program management
- Company, travel agent, and source profiles (not just individual guests — B2B profiles matter for invoicing/AR)

### 3.2 Reservations
- Individual and group reservations
- Real-time room availability search
- Rate code management, packages and promotions
- Waitlist management
- Reservation modification and cancellation workflows
- **Overbooking & walk-in protection**: properties can set an overbooking threshold per room type/date (e.g. sell up to 102% of physical inventory against expected no-shows/cancellations). Availability search must check against this threshold, not raw physical inventory, and front desk needs visibility into how oversold a given night is so walk-ins can be handled (accept, waitlist, or relocate) with the real risk in view.

### 3.3 Front Desk
- Check-in / check-out, including express check-in/out
- Room assignment, room moves, upgrades
- Walk-in guest registration
- Key card integration (door lock systems — see Integrations)
- Digital registration cards, online check-in
- **Early / late check-out handling**: every reservation has a scheduled departure time (property-configurable, e.g. 12:00 noon). Checking out before a property-defined early-departure cutoff or after the late cutoff should trigger an automated fee — a half-day rate for late check-out, or a configurable early-departure penalty — posted straight to the folio rather than left for a cashier to remember and add manually.

### 3.4 Point of Sale — Bar, Restaurant & Outlets

The bar and restaurant are where a hotel leaks the most revenue, and where the PMS earns its keep by connecting a drink poured at 11pm to the right room folio. This is a **first-class module, not an integration** — the terminals are hardware Planmsys supplies, and the software runs inside the product.

**Outlets and terminals**
- Multiple outlets per property (bar, restaurant, room service, spa, poolside), each with its own menu, tax treatment, and opening hours
- Terminals assigned to an outlet; count varies per customer, never hardcoded
- Each terminal identifies the staff member operating it — every order must be attributable to a person, not "the bar terminal" (same principle as folio postings, 3.17)

**Menu management**
- Items with categories, prices, and per-outlet availability. The same item may be priced differently at the pool bar and the restaurant.
- Modifiers and options (double, no ice, side choice) affecting price
- Stock-out toggle so staff can mark an item unavailable without an admin editing the menu
- Happy-hour or time-based pricing where the outlet needs it

**Order flow**
- Open a tab, add items, run multiple tabs simultaneously — a bar has several open at once, and a UI that assumes one active order at a time is unusable in practice
- Transfer a tab between staff at shift change; transfer or merge tabs between tables
- Split a bill by item or evenly, mirroring the folio split rules in 3.5
- Void an item with a reason before settlement; **voids are audited** — this is the single most common vector for staff theft in food and beverage
- Kitchen/bar ticket printing or display, so the order reaches the person making it

**Settlement — where POS meets the PMS**
- **Charge to room**: look up an in-house guest by room number or name, post to the correct open folio as a `pos_charge` line (3.5). Reject if the folio is closed, the guest has checked out, or the room has no in-house reservation — this check is what stops charges landing on strangers.
- **Room-charge authorisation**: configurable per property — signature, room key presented, or PIN. A room number alone is not identification; anyone can read a door.
- Direct settlement: cash, card, contactless, or NQR via the same gateway layer as the rest of the product (3.15)
- Walk-in customers with no room — outlets serve the public too, and the module must not assume every customer is a guest
- Tips and service charge, configurable per outlet and reportable per staff member
- Every settlement posts to the folio or the outlet's cash-up, never both

**Guest self-ordering by QR code**

Each table in an outlet and each guest room carries its own printed **QR code** (not a barcode — a QR holds a URL and scans from any angle on a phone; a 1D barcode does neither). Scanning opens the outlet menu in the guest's browser with **no app install and no login** — the code itself identifies where the order came from.

- **The QR encodes a signed token**, not a plain table number. A URL like `/order?table=12` invites anyone to order against any table, or against a room they aren't staying in. The token identifies outlet + table (or room), is signed so it can't be forged, and is rotatable per property if codes are copied or photographed.
- **Room codes and table codes behave differently**: a table order settles immediately by card/NQR; a room code additionally offers **charge to room**, but only after verifying an in-house reservation exists for that room (a room number is not identification). If the room has no in-house guest, only direct payment is offered.
- **The concrete second-factor mechanism** for charge-to-room, so an implementer isn't left to invent one: scan → verify the signed room token → verify an in-house reservation exists for that room → guest enters a short PIN they were given at check-in (printed on the registration card, 3.16) → optional name confirmation shown back to them for a sanity check → charge posts. A property may instead configure a one-time code sent to the guest's registered phone or email at the point of charge, if they prefer not to issue a check-in PIN. Either mechanism is acceptable; **inventing something weaker at implementation time (e.g. accepting the room number alone, or a static unchanging PIN shared across the property) is not.**
- **Guests order and pay in one flow** — browse menu, add items with modifiers, see the total including tax and service charge, pay by card/NQR, receive an on-screen and emailed receipt with an order number.
- **Payment status travels with the order.** Bar and kitchen staff must see, on the ticket, whether the order is `PAID`, `CHARGED TO ROOM 214`, or `UNPAID — pay on delivery`. This is the point of the whole feature: the person making the drink knows who ordered it and whether the money has arrived, without asking anyone.
- **Order routing**: the ticket appears on the outlet's screen (see "POS screens" below) tagged with the table label or room number, so it reaches the right bar or kitchen and the runner knows where to take it.
- **Live order status for the guest** — received → preparing → on its way. Without it, guests re-order thinking the first attempt failed, and staff get duplicates.
- **Staff acceptance step** before preparation, so an outlet that is closed, out of stock, or slammed can reject or delay an order rather than silently dropping it. An unattended screen must not accept orders indefinitely — configurable auto-reject with a message to the guest.
- **Guest-side abuse controls**: rate-limit orders per token, cap unpaid order value per table, and let staff disable ordering for a table or the whole outlet in one tap.
- The ordering pages are **tenant-themed** like the booking portal (3.14) — the hotel's branding, on the hotel's domain, not a third-party-looking page.
- **Table and room QR management** lives in setup (see "Setup & Configuration screens" below): generate, print (with the table/room label human-readable beside the code, so a peeled sticker is recoverable), regenerate, and deactivate individual codes.

**Inventory & stock control**

Sales tell you what left the bar; inventory tells you what should have. The gap between them is the number that matters.

- **Stock items** with unit of measure, purchase cost, supplier, and reorder level — tracked separately from menu items, because one menu item consumes several stock items
- **Recipes / bill of materials**: a cocktail consumes measures of spirit, mixer, and garnish. Selling one deducts each component, which is what makes bar stock reconcile at all — deducting "one cocktail" from a bottle count tells you nothing.
- **Goods received** against purchase orders or ad hoc, updating stock and cost
- **Stock takes**: periodic counts entered per outlet, producing **variance between theoretical stock (opening + received − sold) and counted stock**. Persistent negative variance on a specific item or a specific shift is the clearest signal of pilferage a hotel has.
- **Wastage and breakage** recorded with a reason and staff member, so genuine loss is distinguishable from theft — and so wastage isn't the excuse that hides it
- **Low-stock alerts** to the outlet manager; automatic stock-out of a menu item whose components are exhausted, so guests can't order what isn't there (particularly important for QR self-ordering, where no staff member is there to say "we're out of that")
- **Inter-outlet transfers** (bar to restaurant) recorded rather than adjusted away
- **Cost of sales and margin per item**, feeding the outlet's profitability reporting

**Sales reporting — what customers bought**

- Itemised sales by outlet, item, category, staff member, hour of day, and order channel (staff-entered vs guest QR)
- Per-guest and per-room purchase history, linked to the guest profile (3.1) — a returning guest's usual drink is exactly the sort of thing a good hotel remembers
- Top and slow sellers, to drive menu decisions
- Void, discount, and comp reports **by staff member** — the fraud view for F&B
- Theoretical vs actual stock variance by item and period
- Outlet revenue rolls into the property's revenue reporting (3.11) and the daily report at night audit (3.10)

**Shift and cash management**
- Open and close a till with an opening float; blind cash-up at shift end (the operator counts before seeing what the system expects, or the variance figure is worthless)
- Variance reported and audited — a persistent negative variance on one operator's shifts is exactly the signal a manager needs
- Outlet takings roll into night audit (3.11) and the daily report

**Reporting**
- Sales by outlet, by item, by category, by staff member, by hour
- Void and discount reports by staff member — the fraud-detection view for F&B
- Cost of sales and margin per item where the tenant tracks purchase costs
- Outlet revenue appears in the property's revenue reporting (3.12) alongside room revenue

**Offline resilience — and what "offline card payment" actually means.** A bar cannot stop serving because the network dropped, but this requirement needs a distinction the earlier draft blurred:

- **The PMS application is offline** (terminal lost connectivity to the backend): the terminal queues orders locally and syncs when connectivity returns. Room charges are deferred — never confirmed offline, since the folio state can't be verified without reaching the backend. Cash settlement works offline unconditionally (no verification needed). **Card and contactless settlement offline is only valid if the physical payment terminal itself independently authorizes the transaction with the card network** (most modern card terminals can — they hold their own connection or store-and-forward capability separate from the PMS app). If the payment terminal *also* has no path to the card network, no card/contactless payment can be confirmed as successful, full stop — the app must not claim a card payment succeeded on the strength of the app being offline. This is a real distinction, not a technicality: claiming success for a payment nobody actually authorized is a direct path to unrecoverable revenue loss.
- **Only the payment terminal is offline** (network is fine, the physical card reader lost its own connection): card/contactless is unavailable regardless of app connectivity; cash and room-charge-to-folio still work.

The order queue and the payment-confirmation logic must be able to answer, at all times, "was this specific transaction actually authorized by a payment network, or are we assuming it was" — and never choose the second.

### 3.5 Cashiering
- Guest billing with multiple folios, split billing across guests/accounts
- Multi-currency handling and currency exchange
- Refunds and adjustments
- Payment processing: cash, card, digital (Paystack), NQR (Flutterwave)
- Automated penalty/fee postings (early/late check-out — see Front Desk) must appear as clearly labelled, itemized folio lines, never lumped into the room charge, so the guest can see exactly what they're being charged for.

### 3.6 Housekeeping
- Room cleaning schedules, attendant assignments
- Housekeeping status feed (clean/dirty/inspected/out-of-order)
- Room inspections, maintenance requests
- Lost and found tracking
- Linen and minibar management
- **Housekeeping discrepancy reports**: front desk's system status for a room (e.g. vacant/dirty from checkout) and the housekeeper's physically-observed status (e.g. still occupied, or occupied but not checked in) can disagree — because of a late walk-out, an unregistered guest, or a stayover the system doesn't know about. Flag any mismatch between the front-desk-expected status and the housekeeper-reported status as a discrepancy requiring front-desk follow-up before the room can be sold again; don't silently overwrite one status with the other.

### 3.7 Rooms Management
- Live room inventory and status
- Out-of-order / out-of-service rooms

### 3.8 Group Blocks / Events
- Group room blocks and rooming lists
- Group billing
- Meeting/event integration

### 3.9 Accounts Receivable
- Company invoicing
- Credit management, outstanding balance tracking
- Payment collection workflows

### 3.10 Night Audit (End of Day)
- End-of-day processing
- Financial reconciliation
- Automatic business-date rollover
- Daily reports triggered at rollover

### 3.11 Reporting & Analytics
- Occupancy, revenue, forecast, housekeeping, financial reports
- Real-time KPI dashboard
- Custom dashboards per role
- **Exports**: every report exportable to PDF (for printing/sharing — night audit and financial reports especially) and Excel/CSV (for the hotel's accountant to work with). Export must reflect the filters currently applied on screen, not silently dump the unfiltered set.
- **Scheduled delivery**: recurring reports emailed on a schedule (e.g. daily night-audit summary to the manager, weekly revenue report to ownership) — configured per report, per recipient list. Failures here are silent by nature, so schedule runs log delivery status (3.21).

### 3.12 Revenue Management
- Dynamic room pricing, rate codes, packages/promotions
- Occupancy forecasting, yield management

### 3.13 Multi-Property Management
- Central guest database shared across properties
- Cross-property reservations
- Chain-wide reporting, multi-property administration

### 3.14 Guest-facing / Online
- Online booking engine (rooms + event halls) on the hotel's own domain, white-labelled
- Guest account registration/login
- Secure online payment (Paystack) to confirm bookings
- Automatic booking confirmation + receipt by email

### 3.15 Integrations
- POS systems (bar/restaurant terminals) — must support contactless/NFC tap-to-pay in addition to chip and swipe; this is a hardware requirement to confirm when ordering terminals, not something the integration code can retrofit (see Section 2)
- Door lock systems (key cards) — card encoding on check-in (core scope), and optionally two-way: ingesting door-open events back from the lock system for occupancy fraud detection (3.23, phase 2). Note there is no universal lock API standard: each vendor (Salto, Onity, dormakaba, Assa Abloy) has its own proprietary interface, often gated behind a paid certification program, and older systems may offer only a serial/socket protocol or file drop rather than a REST API. Confirm the property's exact lock make and model before scoping this work — it is not estimable until the vendor is known.
- Telephone systems
- Payment gateways behind one internal interface — Paystack and Flutterwave (NQR) are the launch adapters, not the abstraction. Adding a processor for a new market must not require changes in Cashiering, the booking portal, or POS.
- Channel managers (OTA distribution — Booking.com, Expedia, etc.)
- Online booking engines (distinct from channel managers — this is the direct-booking engine embedded in the property's own website, see 3.14)
- Accounting software export
- Revenue management systems (external RMS feeds for rate/forecast data, if the property uses one beyond the built-in Revenue Management module)
- Open REST API for third-party integrations

### 3.16 Authentication & Identity

The first screen every user meets, and the one place where getting it wrong compromises everything else. Note there are **three distinct identity populations** — never merge them into one users table or one login flow:

1. **Hotel staff** (front desk, cashier, housekeeping, manager, admin) — belong to a tenant, log in to the PMS
2. **Guests** — belong to a property's guest database, log in to the booking portal only (3.14), and must never be able to reach a PMS route
3. **Platform staff** (Planmsys) — belong to no tenant, access the platform console, and reach tenant data only via audited impersonation (SECURITY.md §2)

**Staff login**
- Email + password, scoped to a tenant resolved **before** any query runs — never by an unscoped lookup on email, which the scoped data-access layer (SECURITY.md §2) makes structurally impossible by design, and which would be ambiguous anyway since email is unique per tenant, not globally (two tenants may share a staff email, and the isolation tests deliberately cover this). Every tenant gets a default subdomain from `tenants.slug` (e.g. `alpha-hotels.lodgekeep.app` and `beta-resorts.lodgekeep.app` for two unrelated hotel groups — this spec uses no single reference customer, per §1); the `Host` header resolves `tenant_id` deterministically at the start of the request, before the login handler touches the database. A custom domain (where the tenant has one) resolves the same way through a domain-to-tenant lookup — same mechanism, different source column. A tenant without a domain to log in from cannot be reached by an unscoped guess; recovery for "I don't remember my company's URL" is an asynchronous email listing the user's tenant(s), never a synchronous response that would let email addresses be enumerated against the tenant list.
- Password hashing with bcrypt or argon2, never anything reversible. Enforce a minimum length rather than composition rules (a long passphrase beats forced symbols), and check new passwords against a breached-password list.
- Rate limiting and progressive lockout on failed attempts, per account **and** per IP — a shared front-desk terminal means one IP legitimately serves many staff.
- **MFA required for admin and super-admin roles**, optional (tenant-configurable) for the rest. A manager account with rate and refund authority is worth attacking.
- Session tokens carry `tenant_id`, `property_id` scope, role, and expiry. Short-lived access token with refresh; refresh tokens are revocable, and revocation must actually take effect (a token valid until natural expiry after a dismissal is a real risk in hospitality, where turnover is high).
- **Shift-appropriate session handling**: front-desk terminals are shared and rarely logged out. Auto-lock after inactivity with quick re-entry (PIN or password) rather than a full re-login, so a busy check-in isn't lost — but the audit trail records the actual user, never "the terminal". Every folio posting must be attributable to a person.
- Password reset by emailed single-use, time-limited token (3.21). Never email a password. Resetting invalidates active sessions.
- Staff invitation flow: admin invites by email, invitee sets their own password. Admins never set a password on someone's behalf — it destroys attributability.
- Deactivation is immediate and revokes sessions; the user record survives for audit trail references (3.19).

**Guest login (booking portal, 3.14)**
- Separate credential store and separate session; a guest session must never satisfy a PMS route
- Email + password, plus guest checkout without an account (requiring registration to book loses bookings)
- Optional social login where a tenant wants it; magic-link email login is a good fit for guests, who log in rarely and forget passwords

**Platform staff login (Planmsys)**
- Separate login surface from the tenant PMS, MFA mandatory with no opt-out
- No implicit access to tenant data — reaching it requires the explicit, logged, time-bounded impersonation path in 4.2

**Cross-cutting**
- All authentication events are audited: successful logins, failures, lockouts, password changes, MFA enrolment, impersonation start/end
- Generic failure messages — "email or password is incorrect", never "no account with that email", which enumerates valid accounts
- Session cookies (where used) are `HttpOnly`, `Secure`, `SameSite=Lax`; tokens are never placed in `localStorage` where an XSS can read them
- **Every API route is authenticated by default.** Public routes (guest booking search, login itself) are an explicit allow-list — never the reverse, where forgetting a decorator silently exposes an endpoint.

### 3.17 Administration & Security
- User roles and permissions (RBAC) — front desk, cashier, housekeeping, manager, admin, super-admin
- Full audit trail on reservation, folio, and rate changes (who, what, when, before/after state)
- Data encryption at rest and in transit (TLS)
- Secure payment processing (tokenised via Paystack/Flutterwave — no raw card data ever touches the app's own DB)
- Tax configuration per property
- Multi-language support at the UI layer
- Multi-currency support (display and folio currency, independent of payment settlement currency)
- Automatic email confirmations (booking, cancellation, receipt)
- Cloud-based access — no on-prem dependency, accessible from any device with a browser

### 3.18 Mobile Features (parity with OPERA Cloud mobile)
- Mobile front desk: check-in/out, room assignment, and walk-in registration from a phone/tablet, not just the desktop terminal
- Mobile housekeeping: attendants update room status (and discrepancy flags — see 3.6) from a phone as they physically clean/inspect rooms, not from a shared terminal after the fact
- Tablet check-in/check-out: a dedicated tablet-optimised flow for lobby self-service or agent-assisted check-in, separate from the full front-desk screen
- Mobile guest services: guest-facing requests (housekeeping, room service, late check-out request) reachable from a phone, ideally the same guest portal used for booking (3.14)

This isn't a separate app — it's the same React frontend rendering role-appropriate, mobile-first views (see the `/frontend` structure in Section 5) rather than a shrunk-down desktop UI.

### 3.19 System Setup & Configuration

Everything below must exist before the property can take its first booking. This is day-one work, not an afterthought — a PMS with no rooms defined does nothing at all.

- **Property setup**: name, address, contact details, timezone, currency, logo and brand colours (drives the white-labelled guest portal, 3.14), and the property's opening business date
- **Room types**: code, name, description, default occupancy, base rate, photos (used by the booking portal)
- **Physical room inventory**: room number, floor, room type, connecting-room links, initial status. Must support bulk entry — nobody should hand-key 60 rooms one form at a time.
- **Rate plans & rate codes**: rate code creation, seasonal/date-range rates, packages and promotions, per-room-type pricing
- **Tax configuration**: VAT and any consumption/tourism levies, defined per property with effective dates. Tax rules change; the system must handle a rate change without retroactively altering historical folios.
- **User & staff setup**: create users, assign roles (see "Role-based views" below), deactivate leavers. Deactivation must never delete the user — audit trail references depend on the user record surviving.
- **Market segments & booking sources**: needed for meaningful revenue reporting later; if these aren't set up at the start, historical reports can't be reconstructed
- **Cancellation & no-show policies**: rules and any associated fees, referenced at reservation time

Configuration changes are audited like any other privileged action (SECURITY.md §6). A rate or tax change is financially significant and needs the same who/what/when trail as a folio adjustment.

### 3.20 Data Migration

The property will arrive with existing records — commonly spreadsheets, sometimes an export from a previous system, occasionally paper. Migration is a one-off but it is the first impression the client has of the system, and bad data poisons everything downstream.

- **Supported inputs**: CSV/Excel import for guest profiles, historical and future reservations, company/travel-agent profiles, and outstanding AR balances
- **Template-driven**: publish a column template per entity rather than trying to parse arbitrary spreadsheets. Ambiguous manual mapping is where migrations go wrong.
- **Validation before commit**: every import runs as a dry run first — row count, rows that will be created vs skipped, and a per-row error list (missing required fields, invalid dates, unknown room types, departure before arrival). Nothing is written until the operator confirms.
- **Deduplication**: match incoming guests on email, then phone, then name + date of birth. Present likely duplicates for a human decision rather than silently merging or silently duplicating — a wrongly merged guest profile is very hard to unpick later.
- **Future reservations need room availability checked** at import time; an imported booking that oversells a date must be flagged, not silently accepted.
- **Idempotent and reversible**: each import run gets an id, every created record is tagged with it, and a run can be rolled back wholesale if the data turns out to be wrong. Assume the first attempt will be wrong.
- **Migration report**: what was imported, what was skipped and why, retained afterwards as the record of what happened.
- Historical folio detail is generally **not** worth migrating — bring balances forward as opening AR entries rather than reconstructing closed folios. Agree this with the client explicitly, because "we'll bring your history across" means very different things to each side.

### 3.21 Notifications & Email

Automatic confirmations are listed as a feature throughout this document (3.14, 3.4) and are easy to treat as trivial. They aren't: a booking confirmation that silently fails to send generates a support call, a guest who turns up with no reference, and a hotel that stops trusting the system.

- **Transactional email**: booking confirmation, booking modification, cancellation, payment receipt, pre-arrival message, checkout folio/receipt, password reset, staff account invitation
- **Provider**: a transactional email service with delivery webhooks (not raw SMTP from the app server, which lands in spam and gives no delivery visibility). Sending domain needs SPF/DKIM/DMARC configured per property, since mail goes out under the hotel's own domain (3.14).
- **Templates**: per-property branded (logo, colours, hotel name), and template content editable by an admin without a code deploy. Multi-language where the property needs it (3.4).
- **Delivery log**: every send recorded with recipient, template, timestamp, and delivery status from the provider webhook (sent / delivered / bounced / failed). This log is the answer to "the guest says they never got it" — without it that question is unanswerable.
- **Retry & failure handling**: transient failures retried with backoff; hard bounces surfaced to staff rather than swallowed. A failed confirmation on a live booking should raise a visible alert, not just a log line.
- **In-app notifications**: the top-bar bell (see "App shell" below) for operational events — new online booking received, payment received, housekeeping discrepancy raised (3.6), night audit due or overdue.
- **Guest SMS/WhatsApp** (optional per tenant): in several target markets WhatsApp is a more reliable channel than email. Treat every channel as pluggable behind the same notification service rather than a parallel implementation, and let each tenant enable the channels that suit their guests.
- **Never put sensitive data in an email body**: no card details, no full folio with payment instruments, no passwords. Link to the portal instead.

### 3.22 Tenant Onboarding & Subscription Billing (SaaS platform layer)

This module is about **Planmsys' relationship with its hotel customers**, not the hotel's relationship with its guests. It has no equivalent in OPERA, because OPERA is sold as a licence — but a SaaS product cannot run without it.

Keep it strictly separate from the PMS modules: hotel staff never see it, and it must never be confused with Accounts Receivable (3.9), which is the hotel invoicing *its* corporate clients.

- **Signup & tenant provisioning**: self-service signup creates the tenant record, the first admin user, and an empty property ready for setup (3.19). No engineer in the loop.
- **Trial handling**: time-limited trial, clear expiry behaviour. Decide deliberately what happens at expiry — a PMS holding live reservations cannot simply lock out a hotel mid-service. Read-only degradation with a grace period is safer than a hard cutoff, and data must be retained for a defined window rather than deleted at expiry.
- **Plans & entitlements**: plan definitions (e.g. by property count, room count, or feature tier) and a single entitlement check used everywhere. Gated capabilities include multi-property (3.13), advanced revenue management (3.12), channel manager integration (3.15), and door access monitoring (3.23).
- **Subscription billing**: recurring charges to the tenant, invoices, payment method on file, dunning on failed payment. No single gateway covers every market — build the billing processor as a pluggable adapter from the start, since expanding beyond the launch region will otherwise mean reworking billing under live customers.
- **Usage metering** where plans are usage-based (rooms, properties, or bookings) — metered per tenant, per billing period.
- **Tenant lifecycle**: suspend (non-payment), reactivate, and offboard. **Offboarding must include a full data export** for the departing customer — their guest and reservation data is theirs, and withholding it is both an ethical and legal problem under NDPA/GDPR. Define a retention window before deletion, and honour it.
- **Platform admin console** (Planmsys staff only): tenant list, plan and status, support impersonation via the audited path in 4.2, and aggregate platform health. Never a back door into tenant data.

### 3.23 Door Access Monitoring & Occupancy Fraud Detection — **PHASE 2**

> **Scope status:** not in the initial build. This depends on lock hardware capability that has not yet been verified for the property, and on a lock-vendor integration whose cost and effort cannot be estimated until the exact make and model is known (see 3.15). Do not build against this section, and do not commit it to a client, until the vendor question in "Hardware tiers" below is settled. It is documented here so the design is ready when it is.

The door lock system knows who *physically* entered a room. The PMS knows who is *billed* for it. Reconciling those two continuously is the strongest control a hotel has against unrecorded occupancy — a room being sold or lent out without a reservation, a check-in, or a payment being recorded in the system.

**Ingest side:**
- Every door-open event from the lock system is ingested and stored: `room_id`, `card_id`, `opened_at`, `card_type` (guest / staff / master / maintenance), `staff_user_id` where the card maps to an employee.
- Events are stored append-only and are never editable from the UI — this is evidence, and its value depends entirely on nobody being able to quietly amend it.
- Ingestion must be resilient: lock systems commonly buffer offline and dump events in batches, so accept out-of-order and delayed events, dedupe on the vendor's event id, and never assume real-time delivery. An event arriving three hours late is normal, not an error.

**Detection rules** (evaluated on ingest, and again during night audit as a sweep):
- **Unsold occupancy** — a guest card opens a room that has no checked-in reservation against it. This is the headline fraud case: someone is in a room the system thinks is empty.
- **Vacant room accessed repeatedly** — a room marked vacant/available shows a pattern of guest-card door-opens, especially overnight.
- **Card active without folio** — a valid guest card exists for a room whose reservation was cancelled, checked out, or has no open folio.
- **Payment mismatch** — a room is occupied (door activity confirms it) but its folio has no room charge posted for that business date, or a zero balance with no payment record.
- **Post-checkout access** — guest card opens a room after checkout was recorded.
- **Out-of-order room accessed** — a room marked OOO/OOS (which should be empty) shows guest-card activity, a classic way to hide an unrecorded let.
- **Staff/master card anomalies** — master card used on a guest room outside that staff member's assigned shift or housekeeping assignment, or an unusual volume of master-card opens by one employee.

**Alerting & notification:**
- Confirmed anomalies raise an alert with severity: `info` (worth reviewing), `warning` (likely error), `critical` (probable revenue fraud — unsold occupancy, post-checkout access, OOO access).
- Delivery: in-app notification to the top-bar bell (see "App shell" below) for manager/admin roles, plus email for `critical`. Front desk and housekeeping do **not** receive fraud alerts — the people with the most opportunity to commit this fraud shouldn't be the ones notified it was detected.
- Every alert records its evidence (the specific door events + the PMS state at that moment) so a manager can act on facts rather than a bare flag. Snapshot the evidence at detection time rather than recomputing it later, because PMS state changes after the fact.
- Alerts have a lifecycle: open → acknowledged → resolved (with a mandatory reason), and resolution is written to the audit trail. A dismissed alert must remain visible in history — an alert someone can silently delete is worthless as a control.

**Night audit tie-in (3.10):** the audit run includes an occupancy reconciliation sweep — compare every room with door activity that business date against rooms with checked-in reservations and posted room charges. Discrepancies land in the daily report and cannot be cleared by the night audit itself; they need a manager.

**Hardware tiers and ingestion modes — build vendor-agnostic:**

Lock hardware varies enormously, and the property's existing locks may not support live events. The ingestion layer must therefore be written **mode-agnostic from day one**, so upgrading hardware later is a config change, not a rebuild. Three tiers exist:

| Tier | How it works | Ingestion mode | Fraud detection you get |
|---|---|---|---|
| **Standalone offline** (cheapest, common in smaller independent hotels) | Battery lock, no network. Card encoded at front desk with expiry baked in. Lock stores its own audit trail internally (typically last ~100–1000 events); staff pull it with a handheld reader. | `manual_import` — file upload of the pulled audit trail | After-the-fact investigation only. No live alerting. |
| **Networked / online** (the target tier) | Locks report to an on-site server or cloud via wired/Wi-Fi/Zigbee gateway. Vendor exposes an API, webhook, or DB/file interface. | `webhook` (push) or `polling` (scheduled pull) | Full real-time detection per the rules above. |
| **Cloud / mobile-key** (BLE, phone as credential) | Fully API-first, events stream live. | `webhook` | Full real-time, plus mobile key issuance. |

**Design requirement:** all three modes write to the *same* event store and run through the *same* rules engine. The mode only affects **how events arrive and how late they are** — never how they're stored or evaluated. Concretely:

- The ingestion layer is a thin adapter per lock vendor/mode behind one internal interface; the rules engine never knows which adapter produced an event.
- Store the event's occurrence time and its ingestion time separately, because they diverge — by seconds on a webhook, by days on a manual import. Rules must key off occurrence time and business date, never ingestion time.
- Dedupe on (lock system, vendor event id) in every mode; offline locks re-send overlapping batches on each pull, and manual imports get uploaded twice by staff routinely.
- Detection rules run **on ingest regardless of mode**, plus as a night-audit sweep. A manual import three days late must still raise its alerts — flagged as retrospective, not suppressed for being stale.
- Alert severity is unchanged by mode, but the UI must show event age so a manager knows whether they're looking at something live or historical.
- Lock configuration (vendor, tier, ingestion mode, real-time capability) is **per-property data, not code** — switching a property from manual import to webhook after a hardware upgrade is a config row update.

**Supported vendor adapters (admin-selectable per property).**

The lock system is chosen by an admin in the UI (see "Setup & Configuration screens" below), not fixed in code. Each option below is an adapter behind the one internal ingestion interface; the rules engine never knows which produced an event. Adding a vendor later means writing an adapter, not touching any module.

| Adapter | Vendor product | Tier | Ingestion mode | Notes |
|---|---|---|---|---|
| `none` | — | — | — | **Default.** Key cards handled outside the PMS entirely; no door events, no fraud detection. Most properties start here. |
| `hiread_prousb` | HiRead ProUSB | Standalone offline | `manual_import` | Windows encoder + desktop software at the front desk. Audit trail pulled per-door with a handheld reader, then uploaded. Retrospective only. |
| `hiread_elock` | HiRead eLock | Standalone offline | `manual_import` | As above. |
| `hiread_tthotel` | HiRead TTHotel / TTLock | Bluetooth, cloud-backed | `polling` or `webhook` | TTLock operates a public developer platform with openly documented cloud APIs — no paid certification gate, unlike Salto/Onity/dormakaba. **Real-time depends on WiFi gateways** being installed: without them the locks are Bluetooth-only and unlock records reach the cloud only when a staff phone syncs with the lock, giving delayed retrospective data. With gateways, records arrive in near real time. |
| `generic_csv` | Any | Standalone offline | `manual_import` | Fallback for a vendor with no adapter: map their export columns to the standard event shape. Keeps the product usable with hardware nobody has integrated yet. |

**Adapter contract.** Every adapter, regardless of tier, normalises to the same event shape — room, card id, card type, occurrence time, grant/deny result, and a vendor event id for deduplication. Anything vendor-specific (TTLock's lock/gateway identifiers, ProUSB's encoder export columns) is mapped inside the adapter and never leaks into the rules engine, the alert model, or the UI.

**Before committing to TTHotel**, confirm two things with the vendor that cannot be verified from their product pages: that the API exposes **unlock records** (the read direction — card issuance alone is useless for fraud detection), and whether the hotel-tier product uses the standard TTLock cloud API or a separate interface. Both are procurement questions in the same class as contactless POS (§2 of this file).

**Degraded-mode honesty:** when a property is on `manual_import`, the UI must state plainly that detection is retrospective and depends on staff pulling lock data on a schedule. Do not present retrospective detection as live monitoring — a manager who believes they'd be alerted in real time, and isn't, is worse off than one who knows the limitation.

**Procurement questions to settle before promising real-time alerting** (same discipline as contactless POS in Section 2):
- Is there a PMS integration interface, and is it API/webhook, polled, or manual pull?
- Are door-open events pushed in real time, or only on manual retrieval?
- Does the payload include card ID, card type, timestamp, and grant/deny result?
- Is integration gated behind a certification program or licence fee? Most established vendors (Onity, Salto, dormakaba, Assa Abloy) gate PMS integration behind paid certification — budget for it per property.

**Legal/privacy note:** door access data is guest movement data and staff monitoring data at once. It falls under the same PII handling rules as guest profiles (SECURITY.md §1.1) — encrypted at rest, access restricted to manager/admin roles, and retained on a defined schedule rather than kept forever. Staff should be informed that master-card use is logged; in most jurisdictions covert employee monitoring creates legal exposure, and data protection law generally covers employee personal data as well as guests' (Nigeria's NDPA and the EU/UK GDPR all do). Retention rules are configurable per tenant, since the applicable regime follows the property's location, not the platform's.

**Per-tenant reality:** lock capability differs at every property, so this is never a platform-wide switch. Each tenant's lock tier is configuration (see above), and the product must behave correctly for a tenant whose hardware supports nothing better than `manual_import` — that is likely the common case in the target market. Confirm a property's lock make and model before enabling this for them, and never sell real-time alerting to a customer whose hardware cannot deliver it.


## 3. UI screens by module

See `DESIGN_SYSTEM.md` for the visual language these screens are built from — colours, spacing, typography, the six required states. This section specifies which screens exist and what each must do; DESIGN_SYSTEM.md specifies how they look.

### App shell

**Left sidebar:**
- User panel at top: avatar, name, role label (e.g. "Emily Smith — Manager")
- Quick-access icon row: profile, messages, calendar, security/permissions
- `-- MAIN` nav group: Home, Booking, Rooms, Departments, Staff — each expandable to sub-items
- `-- APPS` nav group: Calendar (with "New" badge), Task
- Active item highlighted with a tinted background pill, not just bold text
- Sidebar contents are **role-filtered** — a housekeeper never renders a Cashiering nav item at all (see 6.18)

**Top bar:**
- Hamburger (sidebar collapse) on the left
- Fullscreen toggle, notifications bell (with unread count), user name + avatar on the right
- Property switcher on the right for multi-property tenants (§3.13) — the current property must always be visible, since posting a charge against the wrong property is unrecoverable. Tenants entitled to only one property still see the property name, just not a switcher.
- When a Planmsys staff member is impersonating a tenant (SECURITY.md §2), a persistent, visually distinct banner states whose account is being viewed and offers an exit action. This must be impossible to miss or dismiss.
- Business-date indicator: the property's current business date (§3.10) shown persistently, because it can differ from the wall-clock date after/before night audit

### Manager dashboard (Home)

- Page greeting ("Hi, Welcome back!") top-left; summary widgets top-right: Customer Ratings (stars + review count) and Total Income (sparkline)
- **KPI card row** (4 cards: icon badge, label, big number, thin trend/progress bar), each bound to real module data, never mock values:
  - Total Booking → Reservations (active/period bookings)
  - Rooms Available → Rooms Management (live inventory count)
  - New Customers → Profiles (new guest profiles this period)
  - Total Revenue → Cashiering / AR (period revenue total)
- **Chart row** (2 widgets): left/wider = trend area chart of two series over time (New vs Returning Customers); right/narrower = donut breaking bookings down by room type (Single, Double, King, Apartment). Both sourced from Reporting & Analytics (3.11).
- **Operational alert strip** (add to the reference layout): today's arrivals/departures counts, rooms with housekeeping discrepancies (3.6), oversold room types for tonight (3.2), and whether night audit has run for the current business date. These are the things a manager needs at a glance and the reference mock doesn't cover them.

### Authentication screens (3.16)

The first impression of the product and the most security-sensitive UI in it. Three separate surfaces — do not attempt one shared login page.

**Staff login** (PMS)
- Tenant-branded on the tenant's subdomain or custom domain (never a shared login page with no tenant context — see §3.16's resolution mechanism). Email, password, "remember this device", forgot-password link, and a "find my company" link for the async recovery flow when the subdomain itself is forgotten.
- Errors are generic ("Email or password is incorrect") and never reveal whether the account exists. After repeated failures, show the lockout state and how long it lasts rather than failing silently.
- MFA challenge as a second step for roles that require it (3.4)
- **Terminal lock screen** — the shared front-desk case. After inactivity the screen locks showing the current user's name and a PIN/password field, preserving in-progress work behind it. A "switch user" action returns to full login. This is the screen that keeps folio postings attributable to a real person rather than to "the front desk".

**Guest login** (booking portal, 6.18) — tenant-themed, entirely separate from the staff surface. Email/password, magic-link option, and prominent guest checkout so booking never requires registration.

**Platform staff login** (Planmsys) — its own surface, mandatory MFA, no tenant branding.

**Shared across all three**
- Password reset: request → emailed single-use link → set new password → confirmation that other sessions were signed out
- Invitation acceptance: invited staff set their own password; the admin never sees or sets it
- All six states from 6.1.1 apply, error and offline especially — a front-desk agent who cannot tell whether login failed or the network dropped will simply retry until locked out
- Session-expiry handling: return to login with a message explaining what happened and, where safe, a route back to where they were. Never a blank redirect mid-check-in.

### Front Desk screens (3.3)

- **Arrivals / Departures / In-House** — three tabbed lists, each a filterable table with guest name, room, rate, folio balance, status pill, and a primary action button (Check In / Check Out)
- **Check-in flow** — guest lookup or walk-in registration, room assignment (with available rooms filtered by housekeeping status), digital registration card, key card encoding step
- **Check-out flow** — folio summary, outstanding balance, payment capture, automated early/late check-out fee shown as its own labelled line before confirmation (3.3/3.5)
- **Room move / upgrade** — side-by-side current vs target room, reason field (goes to audit trail)
- Walk-in path must surface tonight's oversell position for the requested room type before allowing the sale

### Reservations screens (3.2)

- **Availability search** — date range + room type + occupancy; results show sellable inventory against the overbooking threshold, with a clear visual warning when a date is at or over 100% physical capacity
- **Reservation create/edit** — guest profile lookup or create, rate code selection, packages/promotions, special requests
- **Reservation list** — filter by status (waitlisted, confirmed, checked-in, cancelled, no-show), date range, source
- **Calendar / tape chart** — rooms down the side, dates across the top, reservation bars drawn per room; drag to move or extend. This is the single most-used screen for reservations staff — prioritise it over a plain list view.
- **Waitlist** — separate queue view with promote-to-confirmed action

### Guest Profiles screens (3.1)

- **Profile list** with search across name/email/phone/company, VIP badge visible in the row
- **Profile detail**: contact info, preferences, VIP tier, loyalty balance, stay history (past + upcoming reservations), linked company/travel-agent profile, AR balance if applicable
- **Company / travel agent profiles** as a separate tab — these drive AR invoicing (3.9), so credit limit and outstanding balance belong on this screen

### Rooms & Housekeeping screens (3.6, 3.7)

- **Room grid** — the primary rooms view: one tile per room, colour-coded by status, filterable by floor/type/status. Fast visual scan is the whole point; don't make this a plain table.
- **Housekeeping board** — rooms grouped by attendant assignment, with status update controls sized for touch (this is the mobile-first screen, 3.18)
- **Discrepancy report** — dedicated view listing rooms where front-desk status ≠ housekeeper-reported status (3.6), each row showing both values side by side and a resolve action. This must be a first-class screen, not buried in a report dropdown.
- **Maintenance / out-of-order** — raise, track, and clear OOO/OOS with date ranges; rooms marked OOO must visibly drop out of sellable inventory
- **Lost and found**, **linen & minibar** as secondary tabs under Housekeeping

### Cashiering screens (3.5)

- **Folio view** — line items table (charges, taxes, POS charges, payments, adjustments) with running balance; voided lines shown struck-through, never removed (audit requirement)
- **Split billing** — UI to move individual line items between folios on the same reservation; must be obvious which folio is billed to guest vs company
- **Payment capture** — cash / card / Paystack / Flutterwave NQR, with the NQR path showing a scannable QR code on screen
- **Refunds & adjustments** — reason field mandatory, feeds the audit trail

### POS screens (3.4)

A different design problem from the rest of the product: used standing up, at speed, often one-handed, on a touch terminal, by staff with high turnover and minimal training. Optimise for **taps per order**, not information density. This is the one place where the admin design language bends — bigger targets, fewer words, no dense tables.

- **Order screen** — the primary view. Menu grid by category on one side, running tab on the other. Item tiles are large touch targets (well above the 44px minimum; aim for 64px+ here). Adding an item is one tap; modifiers appear only when the item has them.
- **Open tabs** — several tabs live at once, switchable in one tap, each showing table/room label and running total. A bar with six open tabs is normal; a UI assuming one active order is unusable.
- **Settlement** — cash, card, contactless, NQR, or **charge to room**. Charge-to-room opens a guest search by room number or name, showing the guest's name and in-house status before posting, so the operator can confirm they have the right person. A closed folio or checked-out guest is refused here with a plain reason, not a silent failure.
- **Room-charge confirmation** — per the property's configured method (signature capture, key card presented, or PIN). Never room number alone.
- **Split bill** — by item (drag items between splits) or evenly, mirroring folio splitting (3.5)
- **Void** — reason required before settlement; voided items stay visible on the tab, struck through
- **Shift open / cash-up** — opening float, then a **blind count** at close: the operator enters counted cash before the system reveals what it expected. Variance is shown after, and recorded either way.
- **Kitchen/bar ticket** — printed or displayed, so the order reaches whoever makes it
- **Offline banner** — persistent and unmissable when the terminal loses connectivity, with room charging disabled and cash/card still available (3.4)
- **Manager overrides** — discounts, comps, and post-settlement voids require a manager PIN and are audited
- **Incoming QR orders** — guest-placed orders arrive in their own queue, visibly distinct from staff-entered tabs, each showing table/room label and a large **payment status badge** (`PAID` / `ROOM 214` / `UNPAID`). Accept or reject with a reason; rejection notifies the guest. New orders need an audible alert — a bar is loud and nobody is watching the screen.
- **Stock screen** — current levels per item, low-stock highlighted, quick wastage entry (item, quantity, reason), and goods-received entry
- **Stock take** — enter counted quantities per item, then see theoretical vs counted variance side by side after submitting. Blind, like the cash-up: showing the expected figure first makes the count worthless.

**Guest-facing ordering pages (3.4)** — a separate surface from the POS terminal UI, tenant-themed like the booking portal, and used by guests on their own phones:

- **Menu** — categories, photos, prices, items unavailable when their stock components run out. No login, no app install.
- **Cart & checkout** — modifiers, running total with tax and service charge shown before payment, then card/NQR, plus **charge to room** only when the scanned code is a room code with a verified in-house guest.
- **Order status** — received → preparing → on its way, so guests don't re-order thinking it failed.
- **Receipt** — on-screen and emailed, with an order number the guest can quote to staff.
- Invalid, expired, or deactivated QR token shows a plain explanation and the outlet's phone number — never a raw error.

### Back-office screens (3.8–3.13)

- **Group Blocks** — block list, rooming list upload/entry, block pickup progress bar (rooms picked up vs blocked), group folio
- **Accounts Receivable** — aged balance table by company, invoice generation, payment application, credit limit warnings
- **Night Audit** — a guided, single-purpose screen: pre-audit checklist (unposted charges, un-checked-out arrivals, open folios), a prominent Run Night Audit action, and a post-run summary. Show clearly whether tonight's audit has already run — this screen must make double-running obviously impossible (3.10).
- **Reporting** — report catalogue (occupancy, revenue, forecast, housekeeping, financial), date-range picker, on-screen table + export. Custom dashboards per role live here.
- **Revenue Management** — rate calendar (rate by room type by date, editable inline), occupancy forecast chart, yield rules
- **Multi-Property** — property switcher (top bar), chain-wide roll-up dashboard, cross-property reservation search

### Setup & Configuration screens (3.19)

Admin/super-admin only. These are used heavily during onboarding, then rarely — so favour clarity and guardrails over speed.

- **Setup wizard** — a guided first-run flow: property details → room types → rooms → rate plans → taxes → users. Show progress and allow resuming; nobody completes this in one sitting. Until the required steps are done, the rest of the app should make clear it isn't operational yet rather than failing with empty screens.
- **Room type editor** — code, name, occupancy, base rate, description, photo upload
- **Room inventory** — table of physical rooms with inline edit, plus **bulk add** (room number range + floor + type) and CSV import. Hand-keying 60 rooms one at a time is a real onboarding failure point.
- **Rate plan editor** — rate calendar per room type, date-range overrides, packages and promotions
- **Tax configuration** — rate, name, applicability, effective-from date. Changing a tax rate must warn plainly that it applies going forward and does not alter historical folios.
- **User management** — list, create, assign role, deactivate (never delete). Show last login so dormant accounts are visible.
- **Market segments / booking sources** — simple reference-data lists, editable
- **Door lock system** (3.23) — a dropdown of supported adapters, defaulting to **None**. Selecting a vendor reveals only the fields that adapter needs (API credentials for TTHotel; nothing for the offline adapters). The screen must state plainly what the chosen option delivers: "Retrospective detection — staff must pull lock data manually" versus "Near real-time, requires WiFi gateways installed". A **Test connection** action for API-based adapters, so a wrong credential is caught here rather than silently producing no events for a week.
- Destructive-looking config changes (rate changes, tax changes, deactivating a user) get a confirmation step and are written to the audit trail

### Data Migration screens (3.20)

Admin only, and typically used once. Optimise for confidence, not convenience.

- **Import template download** — one per entity (guests, reservations, companies, AR balances), so the client's spreadsheet arrives in a shape the parser expects
- **Upload & dry run** — after upload, show a preview: total rows, rows to create, rows to skip, and an error table listing row number, column, and what's wrong. Nothing is written at this stage.
- **Duplicate review** — likely duplicate guests presented side by side with a keep/merge/create-new decision per pair. Never auto-merge.
- **Availability conflicts** — imported future reservations that would oversell a date shown as warnings before commit
- **Commit & progress** — explicit confirm step, then progress indicator for large imports
- **Import history** — every run listed with its id, date, operator, counts, and a **roll back** action. Assume the first attempt will be wrong.

### Notification screens (3.21)

- **Template editor** (admin) — per-property email templates with live preview and a send-test-to-me action. Editable without a deploy.
- **Delivery log** (admin/manager) — searchable by recipient, template, date, and status (sent/delivered/bounced/failed). This screen exists to answer "the guest says they never received it," so recipient search must be fast and obvious.
- **Failed sends** — a filtered view of hard bounces and failures needing attention, with a resend action. Failures on live bookings surface on the manager dashboard alert strip (see "Manager dashboard" below), not just here.
- **Notification settings** — which events notify which roles in-app, and which recipients receive which scheduled reports (3.11)

### SaaS platform screens (3.22)

Two distinct audiences — keep them visually and structurally separate from the PMS itself.

**Tenant-facing (hotel owner/admin):**
- **Signup & onboarding** — public signup, then straight into the setup wizard (see "Setup & Configuration screens" below). The gap between signing up and having a working PMS is where SaaS customers churn; make the path obvious and resumable.
- **Subscription & billing** — current plan, what it includes, usage against limits, payment method, invoice history with downloads
- **Plan upgrade/downgrade** — show plainly what changes; downgrades that would exceed a new limit (e.g. more properties than the target plan allows) must explain the conflict rather than silently failing
- **Trial state** — days remaining shown persistently once a trial is near expiry, with a clear path to convert. At expiry, degraded/read-only state must explain what's happened and how to restore service — never an unexplained lockout on a system holding live bookings.
- **Data export / offboarding** — self-service full export of the tenant's own data (3.22)

**Platform-facing (Planmsys staff only, separate from the PMS shell entirely):**
- **Tenant list** — status, plan, property/room count, signup date, last activity
- **Tenant detail** — subscription state, billing history, support notes, and the audited impersonation action (SECURITY.md §2)
- **Platform health** — signups, churn, failed payments, aggregate usage. Aggregate metrics only; this console is not a route into individual tenant data.

### Door Access & Fraud Alerts screens (3.23) — **PHASE 2**

> Not in the initial build — see the scope note on 3.23. Documented so the design is ready if the hardware supports it.

Manager/admin only — these screens must not render for front desk or housekeeping roles.

- **Alert inbox** — the primary view: list of open anomalies, newest first, each row showing severity pill (colour per 6.1: red = critical, amber = warning, grey = info), room, rule triggered, timestamp, and status (open/acknowledged/resolved). Filter by severity, room, date range, and rule type.
- **Alert detail** — the evidence view: the door event(s) that triggered it, the PMS state at that moment (reservation status, folio balance, room status), and a timeline of the room's activity around the event. Actions: acknowledge, resolve (mandatory reason field), or escalate. Resolved alerts stay in history — there is no delete.
- **Room access log** — per-room chronological door-event feed, reachable from the room grid (see "Rooms & Housekeeping screens" below) and from any reservation. Shows card type, timestamp, and whether the event matched an expected occupancy.
- **Occupancy reconciliation report** — the night audit sweep output (3.10/3.23): rooms with door activity but no checked-in reservation or no posted room charge for that business date, side by side. Lives under Reporting (see "Back-office screens" below) as well as here.
- Unresolved `critical` alerts surface on the manager dashboard alert strip (see "Manager dashboard" below) and in the top-bar notification bell with a count badge — a fraud alert should not require someone to go looking for it.
- **Lock audit-trail import** (properties on `manual_import`, see 3.23) — upload the file pulled from the handheld reader, with a preview of parsed events, a duplicate count (re-uploads are routine), and a confirm step. After import, show how many alerts were raised retrospectively.
- **Degraded-mode banner** — when the property's lock config has no real-time capability, every screen in this group shows a persistent, non-dismissible banner stating that detection is retrospective and depends on staff pulling lock data on schedule, along with the date of the last successful import. Never let these screens imply live monitoring when the hardware can't deliver it.
- Alerts raised from a retrospective import carry a visible "retrospective — event occurred X days ago" badge, so a manager can tell live detection from historical at a glance.

### Guest-facing booking portal (3.14)

Visually **separate from the admin shell** — this is the hotel's own branded site, not the Spice admin theme. White-label per property: name, logo, colours, domain all config-driven (never hardcode Lodgekeep branding here).

- Search (dates, guests, room or event hall) → results with photos, rates, availability
- Room/hall detail → booking form → guest login or guest checkout
- Paystack payment step → confirmation page + emailed receipt
- Guest account area: upcoming/past bookings, online check-in, digital registration card

### Role-based views (RBAC applies to UI, not just API)

Each role gets its own landing screen and a filtered sidebar — do **not** ship one dashboard with widgets hidden by CSS:

| Role | Lands on | Sees |
|---|---|---|
| Front desk | Arrivals/Departures board | Front Desk, Reservations, Profiles, Rooms (read) |
| Cashier | Open folios list | Cashiering, AR, Profiles (read) |
| Housekeeping | Housekeeping board (mobile) | Housekeeping, Rooms |
| POS operator (bar/restaurant) | Order screen (see "POS screens" below) | POS only — no PMS access. Charge-to-room is a lookup, not folio access |
| Manager | Manager dashboard (see "Manager dashboard" below) | Everything except super-admin config |
| Admin | Manager dashboard | Everything + user/role management, tax config |
| Super-admin (tenant) | Multi-property roll-up | All of that tenant's properties, chain-wide reporting, subscription & billing (see "SaaS platform screens" below) |
| Planmsys platform staff | Platform console (see "SaaS platform screens" below) | Tenant list and platform metrics only. Tenant data solely via audited impersonation (SECURITY.md §2) — never a silent super-role. |

Hiding a nav item is a UX convenience only — the API must independently enforce the same permissions (SECURITY.md §1.1).

