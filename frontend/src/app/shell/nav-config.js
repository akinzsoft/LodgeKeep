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
      { key: 'rooms', label: 'Rooms' },
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
    ],
  },
];
