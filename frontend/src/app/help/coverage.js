/**
 * Help coverage map: one entry for every top-level screen in the staff app and every
 * sub-tab on it, saying whether a Help guide explains it yet.
 *
 *   screen   the sidebar item's key in `shell/nav-config.js` (plus `my_profile`, the
 *            top-bar menu screen, which has no sidebar item)
 *   tab      the tab's label exactly as the screen shows it, or `null` for the
 *            screen as a whole
 *   status   'covered' (with `guides`, the slugs under `content/`) or 'planned'
 *
 * A screen as a whole is 'covered' only when every one of its tabs is. The test in
 * `__tests__/coverage.test.js` reads the real tab lists out of the screen components,
 * so a new tab or screen with no entry here fails it, and so does a covered entry that
 * names a guide that does not exist.
 */

const covered = (guides) => ({ status: 'covered', guides });
const planned = { status: 'planned', guides: [] };

const FRONT_DESK = 'screens/front-desk/01-front-desk-check-in-and-out';
const RESERVATIONS = 'screens/front-desk/02-reservations-and-booking';
const PROFILES = 'screens/front-desk/03-guest-and-company-profiles';
const HOUSEKEEPING = 'screens/front-desk/04-housekeeping';
const NIGHT_AUDIT = 'screens/back-office-and-admin/01-running-night-audit';
const CASHIERING = 'screens/cashiering-and-money/01-cashiering-folios';
const REGISTER = 'screens/restaurant-and-bar/01-selling-at-the-register';
const SHIFTS = 'screens/restaurant-and-bar/02-opening-and-closing-a-shift';
const VOIDS = 'screens/restaurant-and-bar/03-voids-and-card-refunds';
const SUPERMARKET = 'screens/supermarket/01-the-supermarket-till';
const STOCK_ITEMS = 'screens/stock/01-stock-items-recipes-and-reorder';
const STOCK_MOVE = 'screens/stock/02-receiving-requesting-and-moving-stock';
const STOCK_TAKES = 'screens/stock/03-stock-takes-and-wastage';
const STOCK_REPORTS = 'screens/stock/04-stock-reports';
const SUPERMARKET_STOCK = 'screens/supermarket/02-supermarket-stock-and-setup';
const PROPERTY = 'getting-started/01-property';
const ROOMS_AND_RATES = 'getting-started/02-rooms-and-rates';
const TAXES = 'getting-started/03-taxes-and-service-charge';
const PAYMENTS = 'getting-started/04-payments';
const POS_SETUP = 'getting-started/05-pos';
const STAFF = 'getting-started/06-staff-and-approvals';

export const COVERAGE = [
  { screen: 'home', tab: null, ...planned },

  { screen: 'booking', tab: null, ...covered([RESERVATIONS, FRONT_DESK]) },
  { screen: 'booking', tab: 'Availability', ...covered([RESERVATIONS]) },
  { screen: 'booking', tab: 'Tape Chart', ...covered([RESERVATIONS]) },
  { screen: 'booking', tab: 'Reservations', ...covered([RESERVATIONS]) },
  { screen: 'booking', tab: 'Waitlist', ...covered([RESERVATIONS]) },
  { screen: 'booking', tab: 'Front Desk', ...covered([FRONT_DESK]) },

  { screen: 'profiles', tab: null, ...covered([PROFILES]) },
  { screen: 'profiles', tab: 'Guests', ...covered([PROFILES]) },
  { screen: 'profiles', tab: 'Companies', ...covered([PROFILES]) },

  { screen: 'rooms', tab: null, ...covered([ROOMS_AND_RATES]) },
  { screen: 'rooms', tab: 'Room Types', ...covered([ROOMS_AND_RATES]) },
  { screen: 'rooms', tab: 'Rooms', ...covered([ROOMS_AND_RATES]) },

  { screen: 'housekeeping', tab: null, ...covered([HOUSEKEEPING]) },
  { screen: 'housekeeping', tab: 'Board', ...covered([HOUSEKEEPING]) },
  { screen: 'housekeeping', tab: 'Discrepancies', ...covered([HOUSEKEEPING]) },
  { screen: 'housekeeping', tab: 'Out of Order', ...covered([HOUSEKEEPING]) },

  { screen: 'cashiering', tab: null, ...covered([CASHIERING]) },
  { screen: 'cashiering', tab: 'Balances', ...covered([CASHIERING]) },
  { screen: 'cashiering', tab: 'Folio Lookup', ...covered([CASHIERING]) },

  { screen: 'pos', tab: null, ...covered([REGISTER, SHIFTS, VOIDS, POS_SETUP, STOCK_ITEMS, STOCK_MOVE, STOCK_TAKES, STOCK_REPORTS]) },
  { screen: 'pos', tab: 'Register', ...covered([REGISTER]) },
  { screen: 'pos', tab: 'Tickets', ...covered([REGISTER]) },
  { screen: 'pos', tab: 'Guest orders', ...covered([REGISTER]) },
  { screen: 'pos', tab: 'Shifts', ...covered([SHIFTS]) },
  { screen: 'pos', tab: 'Sales', ...covered([VOIDS]) },
  { screen: 'pos', tab: 'QR codes', ...covered([POS_SETUP]) },
  { screen: 'pos', tab: 'Stock', ...covered([STOCK_ITEMS, STOCK_MOVE, STOCK_TAKES, STOCK_REPORTS]) },
  { screen: 'pos', tab: 'Setup', ...covered([POS_SETUP]) },

  // The stock tabs: shown inside POS → Stock, and as the sidebar's own Stock item for storekeepers.
  { screen: 'stock', tab: null, ...covered([STOCK_ITEMS, STOCK_MOVE, STOCK_TAKES, STOCK_REPORTS]) },
  { screen: 'stock', tab: 'Stock items', ...covered([STOCK_ITEMS]) },
  { screen: 'stock', tab: 'Recipes', ...covered([STOCK_ITEMS]) },
  { screen: 'stock', tab: 'Goods received', ...covered([STOCK_MOVE]) },
  { screen: 'stock', tab: 'Requests', ...covered([STOCK_MOVE]) },
  { screen: 'stock', tab: 'Transfer', ...covered([STOCK_MOVE]) },
  { screen: 'stock', tab: 'Stock takes', ...covered([STOCK_TAKES]) },
  { screen: 'stock', tab: 'Wastage', ...covered([STOCK_TAKES]) },
  { screen: 'stock', tab: 'Reorder report', ...covered([STOCK_ITEMS]) },
  { screen: 'stock', tab: 'Reports', ...covered([STOCK_REPORTS]) },

  { screen: 'supermarket', tab: null, ...covered([SUPERMARKET, SUPERMARKET_STOCK]) },
  { screen: 'supermarket', tab: 'Sell', ...covered([SUPERMARKET]) },
  { screen: 'supermarket', tab: "Today's sales", ...covered([SUPERMARKET]) },
  { screen: 'supermarket', tab: 'Request stock', ...covered([SUPERMARKET_STOCK]) },
  { screen: 'supermarket', tab: 'Wastage', ...covered([SUPERMARKET_STOCK, STOCK_TAKES]) },
  { screen: 'supermarket', tab: 'All sales', ...covered([SUPERMARKET]) },
  { screen: 'supermarket', tab: 'Setup', ...covered([SUPERMARKET_STOCK]) },
  { screen: 'supermarket', tab: 'Products import', ...covered([SUPERMARKET_STOCK]) },

  { screen: 'staff', tab: null, ...covered([STAFF]) },

  { screen: 'setup', tab: null, ...planned },
  { screen: 'setup', tab: 'Guided Setup', ...covered([PROPERTY]) },
  { screen: 'setup', tab: 'Property', ...covered([PROPERTY]) },
  { screen: 'setup', tab: 'Branding', ...covered([PROPERTY]) },
  { screen: 'setup', tab: 'Room Types', ...covered([ROOMS_AND_RATES]) },
  { screen: 'setup', tab: 'Rooms', ...covered([ROOMS_AND_RATES]) },
  { screen: 'setup', tab: 'Rate Codes & Calendar', ...covered([ROOMS_AND_RATES]) },
  { screen: 'setup', tab: 'Taxes', ...covered([TAXES]) },
  { screen: 'setup', tab: 'Reference Data', ...planned },
  { screen: 'setup', tab: 'Users', ...covered([STAFF]) },
  { screen: 'setup', tab: 'Email', ...covered([STAFF]) },
  { screen: 'setup', tab: 'Payments', ...covered([PAYMENTS]) },
  { screen: 'setup', tab: 'Security', ...covered([STAFF]) },
  { screen: 'setup', tab: 'Notifications', ...planned },
  { screen: 'setup', tab: 'Support access', ...planned },

  { screen: 'reports', tab: null, ...planned },
  { screen: 'reports', tab: 'Business summary', ...planned },
  { screen: 'reports', tab: 'Occupancy', ...planned },
  { screen: 'reports', tab: 'Revenue', ...planned },
  { screen: 'reports', tab: 'Housekeeping', ...planned },
  { screen: 'reports', tab: 'Payment reconciliation', ...covered([VOIDS]) },
  { screen: 'reports', tab: 'Discounts & comps', ...planned },

  { screen: 'night_audit', tab: null, ...covered([NIGHT_AUDIT, 'common-problems/night-audit-will-not-run']) },

  { screen: 'ar', tab: null, ...planned },
  { screen: 'ar', tab: 'Accounts', ...planned },
  { screen: 'ar', tab: 'Invoices', ...planned },
  { screen: 'ar', tab: 'Ageing', ...planned },
  { screen: 'ar', tab: 'Payments', ...planned },

  { screen: 'group_blocks', tab: null, ...planned },
  { screen: 'group_blocks', tab: 'Blocks', ...planned },
  { screen: 'group_blocks', tab: 'Room Allocations', ...planned },
  { screen: 'group_blocks', tab: 'Rooming List', ...planned },
  { screen: 'group_blocks', tab: 'Pickup & Billing', ...planned },

  { screen: 'billing', tab: null, ...planned },

  { screen: 'migration', tab: null, ...planned },
  { screen: 'migration', tab: 'Templates', ...planned },
  { screen: 'migration', tab: 'New Import', ...planned },
  { screen: 'migration', tab: 'History', ...planned },

  { screen: 'chain_overview', tab: null, ...planned },

  { screen: 'door_access', tab: null, ...planned },
  { screen: 'door_access', tab: 'Alerts', ...planned },
  { screen: 'door_access', tab: 'Import lock log', ...planned },
  { screen: 'door_access', tab: 'Stay confirmations', ...planned },
  { screen: 'door_access', tab: 'Settings', ...planned },

  { screen: 'expenses', tab: null, ...planned },
  { screen: 'expenses', tab: 'Categories', ...planned },
  { screen: 'expenses', tab: 'Record Expense', ...planned },
  { screen: 'expenses', tab: 'Recurring', ...planned },
  { screen: 'expenses', tab: 'Reports', ...planned },

  { screen: 'help', tab: null, ...planned },

  // Opened from the top-bar user menu, not the sidebar. Its approval PIN section is in the staff guide.
  { screen: 'my_profile', tab: null, ...covered([STAFF]) },
];
