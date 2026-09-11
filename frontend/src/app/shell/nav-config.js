/**
 * The default sidebar nav taxonomy — PRODUCT_REQUIREMENTS.md's "App shell"
 * section, Left sidebar: "`-- MAIN` nav group: Home, Booking, Rooms,
 * Departments, Staff ... `-- APPS` nav group: Calendar (with 'New' badge),
 * Task."
 *
 * These are the literal item labels the spec names — reproduced verbatim
 * rather than remapped to the ten OPERA-standard module names §3's module
 * list uses (Reservations, Front Desk, Cashiering, ...), because nothing in
 * the spec says the two are the same taxonomy, and this file's job is to
 * match what's written, not to guess a "corrected" one.
 *
 * `requiredPermission` is absent from every item in MAIN/APPS below except
 * `booking`, for the same reason as before: none of the others has a real
 * module or endpoint yet (PLAN.md Phase 1+ still, for most of them) to
 * define one against.
 *
 * `booking` is PLAN.md Phase 2's reservations module — real now, and this
 * screen's own Manager-dashboard KPI row (§3's "Total Booking →
 * Reservations") is the spec's own confirmation that "Booking" IS the
 * Reservations module under this literal nav label, not a separate concept.
 * Gated on `reservations.view` — the broader of the two Phase 2 permission
 * domains (a `cashier` role holder can see the item and its Reservations/
 * Availability tabs; the screen's own Front Desk tab further gates itself
 * on `front_desk.view`, since SECURITY.md §5 draws those as separate matrix
 * rows). Front Desk has no separate top-level slot in the literal spec —
 * see `BookingScreen`'s own header for why it lives as a tab here instead.
 *
 * SETUP was the first real-permission item (PLAN.md Phase 1); `booking` is
 * the second, following the same pattern `src/auth/rbac.js`'s own header
 * anticipated ("the real catalogue arrives one key at a time as each real
 * module lands").
 */
export const DEFAULT_NAV_GROUPS = [
  {
    label: 'MAIN',
    items: [
      { key: 'home', label: 'Home' },
      { key: 'booking', label: 'Booking', requiredPermission: 'reservations.view' },
      // PLAN.md Phase 2 gap closure: "Profiles" is one of the ten
      // OPERA-standard modules this spec's own §3 module list names, but —
      // like Front Desk/Housekeeping/Cashiering before it — has no separate
      // top-level slot in the literal App-shell nav list either. Filed under
      // MAIN, next to Booking, since a guest profile is reached from a
      // reservation as often as it's searched for directly. Reuses
      // `reservations.view` — the same permission the `guests` endpoints
      // this screen calls are already gated on.
      { key: 'profiles', label: 'Profiles', requiredPermission: 'reservations.view' },
      // Gap closure (user-reported): this key was never wired to a screen
      // in `main.jsx` at all — clicking it silently fell through to Home.
      // Reuses `RoomTypesTab`/`RoomsTab` (`app/setup/`), both real endpoints
      // gated on `setup.view`/`setup.manage` — the same permission this
      // item is now gated on.
      { key: 'rooms', label: 'Rooms', requiredPermission: 'setup.view' },
      // PLAN.md Phase 3: no separate top-level "Housekeeping" slot exists in
      // PRODUCT_REQUIREMENTS.md's literal App-shell nav list either (the
      // same gap Front Desk had in Phase 2 — see BookingScreen's own header)
      // — filed under MAIN, next to Rooms, since housekeeping is a
      // rooms-adjacent operational module, not an admin one.
      { key: 'housekeeping', label: 'Housekeeping', requiredPermission: 'housekeeping.view' },
      // PLAN.md Phase 2.5: same "no separate top-level slot in the literal
      // spec" gap Front Desk/Housekeeping already had — filed under MAIN,
      // next to Booking, since a folio is reached starting from a
      // reservation. Gated on `cashiering.post_charge`, the broader of the
      // two Cashiering keys (SECURITY.md §5: front_desk holds only this
      // one, "Limited" — the screen itself further gates payment/refund/
      // void actions on `cashiering.void_line` via the API's own checks).
      { key: 'cashiering', label: 'Cashiering', requiredPermission: 'cashiering.post_charge' },
      // PLAN.md Phase 4's POS core: same "no separate top-level slot in the
      // literal spec" gap every operational module here already has — filed
      // under MAIN, next to Cashiering, since a POS charge-to-room settles
      // against the same kind of folio Cashiering already manages. Gated on
      // `pos.operate`, the broader of the two POS keys (SECURITY.md §5:
      // pos_operator holds only this one, "Limited" — outlet/terminal/menu
      // configuration and post-settlement voids stay gated on `pos.manage`
      // via the API's own checks, the same split Cashiering's own
      // `cashiering.void_line` already established).
      { key: 'pos', label: 'POS', requiredPermission: 'pos.operate' },
      { key: 'departments', label: 'Departments' },
      { key: 'staff', label: 'Staff' },
    ],
  },
  {
    label: 'APPS',
    items: [
      { key: 'calendar', label: 'Calendar', badge: 'New' },
      { key: 'task', label: 'Task' },
    ],
  },
  {
    label: 'SETUP',
    items: [
      { key: 'setup', label: 'Setup', requiredPermission: 'setup.view' },
      { key: 'reports', label: 'Reporting', requiredPermission: 'reports.view' },
      // PLAN.md Phase 2.5: SECURITY.md §5 has no Night Audit row at all
      // (confirmed by reading that file directly); this session's confirmed
      // decision files it under SETUP, alongside Reporting, since closing a
      // business date is a manager/admin action, not an operational one —
      // gated on `night_audit.view`.
      { key: 'night_audit', label: 'Night Audit', requiredPermission: 'night_audit.view' },
      // PLAN.md Phase 4 (Accounts Receivable) — PRODUCT_REQUIREMENTS.md
      // files this under "Back-office screens," alongside Night Audit/
      // Reporting, not a front-line operational screen — filed under
      // SETUP to match. Gated on `ar.view` (front_desk/cashier/manager/
      // admin/super_admin per SECURITY.md §5's own AR column; `ar.manage`
      // is checked separately, per-action, by the screen's own mutating
      // calls, matching every other module's "broader key gates the nav
      // item, narrower key gates the write" convention).
      { key: 'ar', label: 'Accounts Receivable', requiredPermission: 'ar.view' },
      // PLAN.md Phase 4 (Group Blocks) — PRODUCT_REQUIREMENTS.md's own
      // "Back-office screens" line files this alongside AR/Night Audit/
      // Reporting, not a front-line operational screen — filed under SETUP
      // to match, next to AR. Gated on `group_blocks.view` (front_desk/
      // cashier/manager/admin/super_admin per SECURITY.md §5's own Group
      // Blocks column; `group_blocks.manage` is checked separately, per-
      // action, by the screen's own mutating calls, the same "broader key
      // gates the nav item, narrower key gates the write" convention AR's
      // own item above already established).
      { key: 'group_blocks', label: 'Group Blocks', requiredPermission: 'group_blocks.view' },
      // PLAN.md Phase 5 (subscription billing) — the tenant's own
      // commercial relationship with Planmsys, filed under SETUP alongside
      // AR/Group Blocks/Night Audit/Reporting for the identical
      // "back-office screen, not a front-line operational one" reasoning.
      // Gated on `billing.view` — admin/super_admin only, both keys (see
      // that migration's own header for why this is narrower than every
      // other module's RBAC split: no operational role has a reason to see
      // it, unlike AR/Group Blocks' broader "manager + some operational
      // roles get .view" shape).
      { key: 'billing', label: 'Billing', requiredPermission: 'billing.view' },
      // PLAN.md Phase 5 (data migration) — PRODUCT_REQUIREMENTS.md §3.20's
      // own UI text: "Admin only, and typically used once." Filed under
      // SETUP alongside AR/Group Blocks (a genuine multi-step workflow —
      // upload, dry run, duplicate review, commit/progress, history — the
      // same "big enough to need several tabs of its own" shape those two
      // established, not Offboarding's "tuck into an existing screen"
      // single-action shape). Gated on the one key this module has —
      // `migration.manage`, admin/super_admin only, no view/manage split,
      // mirroring `offboarding.manage`'s own precedent exactly.
      { key: 'migration', label: 'Data Migration', requiredPermission: 'migration.manage' },
    ],
  },
];
