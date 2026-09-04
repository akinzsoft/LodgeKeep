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
      { key: 'rooms', label: 'Rooms' },
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
    items: [{ key: 'setup', label: 'Setup', requiredPermission: 'setup.view' }],
  },
];
