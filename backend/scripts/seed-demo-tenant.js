'use strict';

/**
 * DEV-ONLY demo tenant for marketing screenshots: "Lagos Grand Hotels"
 * (slug `demo-lagos-grand`), a believable Nigerian hotel with 14 days of
 * trading history, built by driving the REAL app in-process (the same
 * controllers, services and ledgers as production), so every report is
 * internally consistent.
 *
 *   cd backend && node scripts/seed-demo-tenant.js           # build (no-op if it exists)
 *   cd backend && node scripts/seed-demo-tenant.js --reset   # delete ONLY the demo tenant, rebuild
 *
 * Logins (password = the repo's published dev password, DEV_PASSWORD in
 * seeds/01_dev_tenants.js):
 *   demo@lagos-grand.example.com      super_admin (MFA switched off for the demo property)
 *   manager@lagos-grand.example.com   manager holding every permission
 *
 * Refuses unless NODE_ENV != production, DB_NAME = lodgekeep_dev and
 * DB_HOST is local. Never calls Paystack; outbox/queue enqueues are stubbed
 * and every outbox row is marked sent so no email can leave.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ quiet: true });

// ---------------------------------------------------------------- guards
const DEMO_SLUG = 'demo-lagos-grand';
const DEV_PASSWORD = 'LodgeKeepDev123!';
if (process.env.NODE_ENV === 'production') throw new Error('Refusing: NODE_ENV=production.');
if (process.env.DB_NAME !== 'lodgekeep_dev') throw new Error(`Refusing: DB_NAME must be lodgekeep_dev (got ${process.env.DB_NAME}).`);
if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST)) throw new Error(`Refusing: DB_HOST must be local (got ${process.env.DB_HOST}).`);

// Stub side-effect queues BEFORE the app loads (modules destructure these at require time).
require('../src/jobs/outbox-dispatcher').enqueueOutboxDispatch = async () => {};
require('../src/jobs/data-import').enqueueDataImportJob = async () => {};

const request = require('supertest');
const knexLib = require('knex');
const knexConfig = require('../knexfile.js');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/auth/tokens');
const { hashPassword } = require('../src/auth/password');
const { signupTenant } = require('../src/modules/signup/service');
const { calendarDateInZone } = require('../src/shared/timezone');
const { TENANT_PURGE_ORDER, SELF_REFERENCES } = require('../src/modules/offboarding/purge-plan');
const { runImportCommitJob } = require('../src/jobs/data-import');

const knex = knexLib(knexConfig.development);
const RESET = process.argv.includes('--reset');
const RUN = Date.now().toString(36);
let keyCounter = 0;

// ---------------------------------------------------------------- utils
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let R = rng(20261006);
const rand = () => R();
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [v, w] of entries) {
    x -= w;
    if (x <= 0) return v;
  }
  return entries[entries.length - 1][0];
}
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const money = (n) => Number(n).toFixed(2);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { tenantId: null, propertyId: null, users: {}, passwordHash: null };
const app = createApp();
const agent = request(app);

const tokenFor = (userId) =>
  signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(state.tenantId), property_id: String(state.propertyId) });

async function call(method, url, { as = 'manager', body, query, allowFail = false } = {}) {
  let req = agent[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokenFor(state.users[as])}`);
  if (method !== 'get') req = req.set('Idempotency-Key', `demo-${RUN}-${(keyCounter += 1)}`);
  if (query) req = req.query(query);
  if (body !== undefined) req = req.send(body);
  const res = await req;
  if (res.status >= 400) {
    if (allowFail) return { failed: true, status: res.status, error: res.body?.error };
    throw new Error(`${method.toUpperCase()} ${url} -> ${res.status} ${JSON.stringify(res.body?.error)} body=${JSON.stringify(body)}`);
  }
  return res.body.data;
}
const get = (url, opts) => call('get', url, opts);
const post = (url, body, opts = {}) => call('post', url, { ...opts, body });
const patch = (url, body, opts = {}) => call('patch', url, { ...opts, body });
const put = (url, body, opts = {}) => call('put', url, { ...opts, body });

/** Mark every outbox row of the demo tenant as sent so no email can ever be dispatched. */
async function quietOutbox() {
  if (!state.tenantId) return;
  await knex('outbox_events').where({ tenant_id: state.tenantId }).whereIn('status', ['pending', 'processing', 'failed']).update({ status: 'sent', processed_at: knex.fn.now() });
}

// ------------------------------------------------- isolation snapshot / reset
async function snapshotOthers() {
  const snap = {};
  for (const table of TENANT_PURGE_ORDER) {
    try {
      const [[row]] = await knex.raw(
        `select count(*) as c from \`${table}\` where tenant_id is not null and tenant_id not in (select id from tenants where slug = ?)`,
        [DEMO_SLUG]
      );
      snap[table] = Number(row.c);
    } catch (e) {
      snap[table] = null;
    }
  }
  return snap;
}

async function resetDemoTenant(tenantId) {
  log(`Resetting tenant ${DEMO_SLUG} (id ${tenantId}) ...`);
  await knex.raw('set session sql_safe_updates = 0');
  for (const table of TENANT_PURGE_ORDER) {
    const selfRef = SELF_REFERENCES[table];
    if (selfRef) await knex(table).where({ tenant_id: tenantId }).update({ [selfRef]: null });
    // delete in chunks (large tables)
    for (;;) {
      const [res] = await knex.raw(`delete from \`${table}\` where tenant_id = ? limit 2000`, [tenantId]);
      if (!res.affectedRows) break;
    }
  }
  await knex('tenant_signups').where({ tenant_id: tenantId }).delete();
  await knex('tenants').where({ id: tenantId }).delete();
}

// ------------------------------------------------------------- data tables
const GUEST_NAMES = [
  ['Chinedu', 'Okafor'], ['Amaka', 'Eze'], ['Tunde', 'Adeyemi'], ['Ngozi', 'Nwosu'], ['Ibrahim', 'Bello'], ['Folake', 'Balogun'],
  ['Emeka', 'Obi'], ['Aisha', 'Mohammed'], ['Segun', 'Ogunleye'], ['Yetunde', 'Akinola'], ['Uche', 'Anyanwu'], ['Hauwa', 'Danjuma'],
  ['Kunle', 'Fashola'], ['Blessing', 'Udoh'], ['Obinna', 'Chukwu'], ['Zainab', 'Lawal'], ['Femi', 'Ojo'], ['Ifeoma', 'Nnamdi'],
  ['Musa', 'Garba'], ['Titilayo', 'Adebayo'], ['Chukwuma', 'Eze'], ['Halima', 'Yusuf'], ['Damilola', 'Ogunbanjo'], ['Nkechi', 'Onyeama'],
  ['Babatunde', 'Salami'], ['Efe', 'Oghene'], ['Ada', 'Okonkwo'], ['Sola', 'Akintola'], ['Ikenna', 'Uzor'], ['Rukayat', 'Sanni'],
  ['Gbenga', 'Adewale'], ['Chiamaka', 'Igwe'], ['David', 'Whitfield'], ['Priya', 'Nair'],
];
const ROOM_TYPES = [
  { key: 'STD', name: 'Standard Room', code: 'STD', rate: '45000.00', rooms: ['101', '108'], floor: 1, occ: 2 },
  { key: 'DLX', name: 'Deluxe Room', code: 'DLX', rate: '65000.00', rooms: ['201', '210'], floor: 2, occ: 2 },
  { key: 'EXE', name: 'Executive Suite', code: 'EXE', rate: '120000.00', rooms: ['301', '306'], floor: 3, occ: 3 },
];
const CAP = { STD: 8, DLX: 10, EXE: 6 };

// ----------------------------------------------------- reservation planner
/** Pure: plan every reservation for offsets -13..+14 (0 = today). */
function planReservations(seed) {
  R = rng(seed);
  const total = 24;
  const occ = { STD: {}, DLX: {}, EXE: {} };
  const used = (t, n) => occ[t][n] || 0;
  const totalUsed = (n) => used('STD', n) + used('DLX', n) + used('EXE', n);
  const plan = [];
  const guestBusy = new Map(); // guestIdx -> [[a,d],...]
  const fits = (type, a, nights) => {
    for (let n = a; n < a + nights; n += 1) if (used(type, n) >= CAP[type]) return false;
    return true;
  };
  const take = (type, a, nights) => {
    for (let n = a; n < a + nights; n += 1) occ[type][n] = used(type, n) + 1;
  };
  const guestFree = (g, a, d) => !(guestBusy.get(g) || []).some(([x, y]) => a < y && d > x);
  const addRes = (type, a, nights, extra = {}) => {
    let g;
    for (let tries = 0; tries < 60; tries += 1) {
      g = ri(0, GUEST_NAMES.length - 1);
      if (guestFree(g, a, a + nights)) break;
    }
    if (!guestFree(g, a, a + nights)) return false;
    take(type, a, nights);
    guestBusy.set(g, [...(guestBusy.get(g) || []), [a, a + nights]]);
    plan.push({ type, arrival: a, departure: a + nights, guest: g, adults: type === 'EXE' ? ri(2, 3) : ri(1, 2), ...extra });
    return true;
  };
  const target = (n) => {
    if (n <= -1) return Math.round(total * (0.28 + 0.44 * ((n + 13) / 12)));
    if (n === 0) return Math.round(total * 0.78);
    return Math.round(total * Math.max(0.42, 0.7 - 0.02 * n));
  };
  const nightsDist = [[1, 28], [2, 36], [3, 22], [4, 14]];
  const typeDist = [['STD', 44], ['DLX', 38], ['EXE', 18]];
  for (let n = -13; n <= 14; n += 1) {
    if (n === 0) {
      let added = 0;
      for (let t = 0; t < 80 && added < 4; t += 1) {
        const type = weighted(typeDist);
        const nights = weighted(nightsDist);
        if (fits(type, 0, nights) && addRes(type, 0, nights)) added += 1;
      }
      continue;
    }
    for (let t = 0; t < 60 && totalUsed(n) < target(n); t += 1) {
      const type = weighted(typeDist);
      const nights = weighted(nightsDist);
      if (fits(type, n, nights)) addRes(type, n, nights);
    }
  }
  // Executive suite sold out around +5/+6, then one waitlisted request.
  for (let t = 0; t < 30 && (used('EXE', 5) < CAP.EXE || used('EXE', 6) < CAP.EXE); t += 1) {
    if (fits('EXE', 5, 2)) addRes('EXE', 5, 2);
    else break;
  }
  plan.push({ type: 'EXE', arrival: 5, departure: 7, guest: ri(0, GUEST_NAMES.length - 1), adults: 2, waitlist: true });
  // a tentative hold and two cancellations in the future
  const future = plan.filter((p) => p.arrival >= 3 && !p.waitlist);
  if (future[0]) future[0].hold = true;
  if (future[3]) future[3].cancel = true;
  if (future[6]) future[6].cancel = true;
  return plan;
}

function acceptablePlan(plan) {
  const arrivals0 = plan.filter((p) => p.arrival === 0 && !p.waitlist && !p.cancel).length;
  const departures0 = plan.filter((p) => p.departure === 0 && p.arrival < 0 && !p.cancel).length;
  const inHouse = plan.filter((p) => p.arrival <= -1 && p.departure >= 1 && !p.cancel).length + departures0;
  const pastCount = plan.filter((p) => p.arrival < 0).length;
  return { ok: arrivals0 === 4 && departures0 === 3 && inHouse >= 16 && inHouse <= 18 && pastCount >= 40, arrivals0, departures0, inHouse, pastCount };
}

// -------------------------------------------------------------------- main
async function main() {
  const before = await snapshotOthers();
  const existing = await knex('tenants').where({ slug: DEMO_SLUG }).first();
  if (existing && !RESET) {
    log(`Tenant ${DEMO_SLUG} already exists (id ${existing.id}). Pass --reset to rebuild it. Nothing changed.`);
    return;
  }
  if (existing) await resetDemoTenant(existing.id);

  const today = calendarDateInZone(new Date(), 'Africa/Lagos');
  const D = (n) => addDays(today, n);
  const startDate = D(-13);
  log(`Today (Africa/Lagos): ${today}; history starts ${startDate}`);

  // ------------------------------------------------------------- tenant
  state.passwordHash = await hashPassword(DEV_PASSWORD);
  const signup = await signupTenant({
    companyName: 'Lagos Grand Hotels',
    slug: DEMO_SLUG,
    timezone: 'Africa/Lagos',
    baseCurrency: 'NGN',
    propertyName: 'Lagos Grand Hotel & Suites',
    adminEmail: 'demo@lagos-grand.example.com',
    adminPassword: DEV_PASSWORD,
    adminFirstName: 'Adaeze',
    adminLastName: 'Nwosu',
  });
  const tenant = await knex('tenants').where({ slug: DEMO_SLUG }).first();
  state.tenantId = tenant.id;
  const property = await knex('properties').where({ tenant_id: tenant.id }).first();
  state.propertyId = property.id;
  const adminUser = await knex('users').where({ tenant_id: tenant.id, email: 'demo@lagos-grand.example.com' }).first();
  state.users.admin = adminUser.id;
  await knex('tenants').where({ id: tenant.id }).update({ status: 'active', trial_ends_at: null });
  await knex('properties').where({ id: property.id }).update({ mfa_required_for_admin_roles: false, address: '14 Adeola Odeku Street, Victoria Island, Lagos' });

  // Staff
  async function addStaff(key, email, first, last, role) {
    const [id] = await knex('users').insert({ tenant_id: tenant.id, email, password_hash: state.passwordHash, first_name: first, last_name: last, status: 'active' });
    await knex('user_property_access').insert({ tenant_id: tenant.id, property_id: property.id, user_id: id, role });
    state.users[key] = id;
    return id;
  }
  await addStaff('manager', 'manager@lagos-grand.example.com', 'Funmi', 'Adeyemi', 'manager');
  await addStaff('frontdesk', 'frontdesk@lagos-grand.example.com', 'Chioma', 'Eze', 'front_desk');
  await addStaff('cashier', 'cashier@lagos-grand.example.com', 'Segun', 'Alabi', 'cashier');
  await addStaff('hk1', 'blessing.okafor@lagos-grand.example.com', 'Blessing', 'Okafor', 'housekeeping');
  await addStaff('hk2', 'grace.ibe@lagos-grand.example.com', 'Grace', 'Ibe', 'housekeeping');
  await addStaff('bartender', 'tunde.bakare@lagos-grand.example.com', 'Tunde', 'Bakare', 'pos_operator');
  await addStaff('storekeeper', 'ibrahim.musa@lagos-grand.example.com', 'Ibrahim', 'Musa', 'storekeeper');
  // The demo manager holds every permission key (full-app screenshots).
  const managerRole = await knex('roles').where({ tenant_id: tenant.id, code: 'manager' }).first();
  const allPerms = await knex('permissions').select('id');
  const have = new Set((await knex('role_permissions').where({ tenant_id: tenant.id, role_id: managerRole.id }).select('permission_id')).map((r) => String(r.permission_id)));
  const grants = allPerms.filter((p) => !have.has(String(p.id))).map((p) => ({ tenant_id: tenant.id, role_id: managerRole.id, permission_id: p.id }));
  if (grants.length) await knex('role_permissions').insert(grants);
  log(`Tenant ${tenant.id}, property ${property.id}; ${Object.keys(state.users).length} staff users.`);

  // ------------------------------------------------------------- setup
  await patch(`/properties/${property.id}`, { current_business_date: startDate });
  // Rate codes (one per room type), room types, rooms
  const roomTypeIds = {};
  const rateCodeIds = {};
  const roomsByType = { STD: [], DLX: [], EXE: [] };
  for (const rt of ROOM_TYPES) {
    const rc = await post('/rate-codes', { code: `RACK-${rt.code}`, description: `${rt.name} — standard rate`, base_rate: rt.rate, currency: 'NGN', valid_from: addDays(startDate, -400) });
    rateCodeIds[rt.key] = rc.id;
    const type = await post('/room-types', { code: rt.code, name: rt.name, description: `${rt.name} at Lagos Grand`, default_occupancy: rt.occ, base_rate: rt.rate, primary_rate_code_id: rc.id });
    roomTypeIds[rt.key] = type.id;
    await post('/rooms/bulk', { room_type_id: type.id, floor: rt.floor, from: rt.rooms[0], to: rt.rooms[1] });
  }
  const allRooms = await get('/rooms');
  for (const room of allRooms) {
    const key = ROOM_TYPES.find((t) => String(roomTypeIds[t.key]) === String(room.room_type_id)).key;
    roomsByType[key].push({ id: room.id, number: room.room_number });
  }
  log(`Rooms: ${allRooms.length}`);
  // Taxes
  await post('/taxes', { tax_code: 'VAT', name: 'VAT 7.5%', rate: '7.5', effective_from: addDays(startDate, -400), is_inclusive: false, calculation_method: 'percentage', applies_to: 'all', jurisdiction: 'Nigeria (FIRS)' });
  await post('/taxes', { tax_code: 'VATSUP', name: 'Supermarket VAT 1.5%', rate: '1.5', effective_from: addDays(startDate, -400), is_inclusive: false, calculation_method: 'percentage', applies_to: 'supermarket_sale', jurisdiction: 'Nigeria (FIRS)' });
  // Reference data
  const segs = {};
  for (const [code, name] of [['LEI', 'Leisure'], ['CORP', 'Corporate'], ['GOV', 'Government & NGO']]) segs[code] = (await post('/market-segments', { code, name })).id;
  const srcs = {};
  for (const [code, name] of [['WALK', 'Walk-in'], ['PHONE', 'Phone'], ['WEB', 'Website'], ['OTA', 'Online travel agent']]) srcs[code] = (await post('/booking-sources', { code, name })).id;
  const policy = await post('/cancellation-policies', { code: 'FLEX48', name: 'Free cancellation up to 48 hours', fee_type: 'first_night', cutoff_hours: 48 });
  // Hotel front-desk terminal account
  await post('/cashiering/terminal-accounts', { provider: 'moniepoint', bank_name: 'Zenith Bank', account_label: 'Front desk POS', account_number: '2041784452' });

  // ------------------------------------------------------------- guests
  const guestIds = [];
  for (const [first, last] of GUEST_NAMES) {
    const slug = `${first}.${last}`.toLowerCase();
    const guest = await post('/guests', { first_name: first, last_name: last, email: `${slug}@example.com`, phone: `+234 80${ri(1, 9)} ${ri(100, 999)} ${ri(1000, 9999)}` });
    guestIds.push(guest.id);
  }
  log(`Guests: ${guestIds.length}`);

  // ----------------------------------------------------------- POS setup
  const outlets = {};
  for (const [key, code, name, type] of [['bar', 'BAR', 'Skyline Bar', 'bar'], ['rest', 'REST', 'Terrace Restaurant', 'restaurant'], ['store', 'STORE', 'Store Room', 'store'], ['mart', 'MART', 'Lagos Mart', 'supermarket']]) {
    outlets[key] = (await post('/pos/outlets', { code, name, type })).id;
  }
  const terminals = {};
  for (const [key, ref] of [['bar', 'SKY-TILL-1'], ['rest', 'TERRACE-TILL-1'], ['mart', 'MART-TILL-1']]) {
    terminals[key] = (await post('/pos/terminals', { outlet_id: outlets[key], device_ref: ref, supports_contactless: true })).id;
  }
  const outletAccounts = { bar: [], rest: [], mart: [] };
  const acctDefs = {
    bar: [['moniepoint', 'Zenith Bank', 'Skyline Bar POS', '2041784461'], ['gtbank', 'GTBank', 'Skyline Bar GTB', '0123456701']],
    rest: [['opay', 'OPay', 'Terrace POS', '8031112233'], ['gtbank', 'GTBank', 'Terrace GTB', '0123456702']],
    mart: [['moniepoint', 'Zenith Bank', 'Lagos Mart POS', '2041784470']],
  };
  for (const key of Object.keys(acctDefs)) {
    for (const [provider, bank, label, number] of acctDefs[key]) {
      const acct = await post(`/pos/outlets/${outlets[key]}/terminal-accounts`, { provider, bank_name: bank, account_label: label, account_number: number });
      outletAccounts[key].push({ id: acct.id, provider });
    }
  }

  // Menu: categories carried per outlet, then items
  const menu = {
    bar: {
      Beers: [['Star Lager 60cl', 1500, 900], ['Heineken 33cl', 1800, 1100], ['Gulder 60cl', 1500, 900], ['Guinness Stout', 1800, 1100]],
      'Soft Drinks & Water': [['Coca-Cola 50cl', 700, 300], ['Chivita Active Juice', 1000, 600], ['Eva Water 75cl', 500, 150], ['Fanta Orange 50cl', 700, 300]],
      'Spirits & Cocktails': [['Hennessy VS (shot)', 3500, 1500], ['Chapman', 3000, 900], ['Mojito', 4500, 1400], ['Red Wine (glass)', 3500, 1300]],
    },
    rest: {
      Starters: [['Pepper Soup (goat)', 3500, 1400], ['Suya Platter', 5000, 2100], ['Moi-moi & Pap', 1500, 500]],
      Mains: [['Jollof Rice & Chicken', 4500, 1700], ['Fried Rice & Turkey', 5000, 2000], ['Egusi & Pounded Yam', 5500, 2200], ['Grilled Fish & Plantain', 6500, 2800], ['Club Sandwich', 4000, 1500]],
      Desserts: [['Fresh Fruit Platter', 2500, 900], ['Vanilla Ice Cream', 2000, 700]],
    },
  };
  const menuItems = { bar: [], rest: [] }; // {id,name,price,cat}
  for (const outletKey of ['bar', 'rest']) {
    for (const [category, items] of Object.entries(menu[outletKey])) {
      await post('/pos/menu-categories', { name: category, outlet_ids: [outlets[outletKey]] });
      for (const [name, price, cost] of items) {
        const item = await post('/pos/menu-items', { outlet_id: outlets[outletKey], name, category, price: money(price), cost_price: money(cost) });
        menuItems[outletKey].push({ id: item.id, name, price, category });
      }
    }
  }
  // Stock: store receives, bar is fed by transfer; recipes link drinks to stock
  const stockDefs = [
    ['Star Lager 60cl', 'Beers', 900], ['Heineken 33cl', 'Beers', 1100], ['Gulder 60cl', 'Beers', 900], ['Guinness Stout', 'Beers', 1100],
    ['Coca-Cola 50cl', 'Soft Drinks & Water', 300], ['Chivita Active Juice', 'Soft Drinks & Water', 600], ['Eva Water 75cl', 'Soft Drinks & Water', 150], ['Fanta Orange 50cl', 'Soft Drinks & Water', 300],
  ];
  // (menu categories already created their stock twins: Beers, Soft Drinks & Water)
  const stockIds = {};
  for (const [name, category, cost] of stockDefs) {
    const item = await post('/pos/stock/items', { outlet_id: outlets.store, name, unit: 'bottle', category, purchase_cost: money(cost), supplier: category === 'Beers' ? 'Nigerian Breweries' : 'Coca-Cola Nigeria Ltd', reorder_level: '24' });
    stockIds[name] = item.id;
    const mi = menuItems.bar.find((m) => m.name === name);
    await put(`/pos/stock/menu-items/${mi.id}/components`, { components: [{ stock_item_id: item.id, quantity: '1' }] });
  }
  async function receiveAndTransfer(qtyReceive, qtyTransfer, ref) {
    const lines = stockDefs.map(([name, , cost]) => ({ stock_item_id: stockIds[name], quantity: String(qtyReceive), unit_cost: money(cost) }));
    await post('/pos/stock/goods-received', { outlet_id: outlets.store, lines, reference: ref });
    for (const [name] of stockDefs) {
      await post('/pos/stock/transfers', { stock_item_id: stockIds[name], from_outlet_id: outlets.store, to_outlet_id: outlets.bar, quantity: String(qtyTransfer), note: 'Bar replenishment' });
    }
  }
  await receiveAndTransfer(400, 150, 'GRN-LG-0001');
  log(`POS: ${menuItems.bar.length + menuItems.rest.length} menu items, stock transferred to bar.`);

  // ----------------------------------------------------------- planner
  let plan = null;
  let info = null;
  for (let seed = 1; seed < 400; seed += 1) {
    const p = planReservations(seed * 7919);
    const verdict = acceptablePlan(p);
    if (verdict.ok) {
      plan = p;
      info = verdict;
      break;
    }
  }
  if (!plan) throw new Error('Could not find an acceptable reservation plan.');
  log(`Plan: ${plan.length} reservations; arrivals today ${info.arrivals0}, departures today ${info.departures0}, in-house ${info.inHouse}, past ${info.pastCount}.`);
  R = rng(424242); // fresh stream for the day loop

  // Create all reservations up front (business date = startDate)
  for (const p of plan) {
    const body = {
      guest_id: guestIds[p.guest],
      room_type_id: roomTypeIds[p.type],
      rate_code_id: rateCodeIds[p.type],
      arrival_date: D(p.arrival),
      departure_date: D(p.departure),
      adults: p.adults,
      market_segment_id: segs[weighted([['LEI', 55], ['CORP', 35], ['GOV', 10]])],
      booking_source_id: srcs[weighted([['WALK', 20], ['PHONE', 25], ['WEB', 35], ['OTA', 20]])],
      cancellation_policy_id: policy.id,
    };
    if (p.hold) body.as_hold = true;
    if (p.waitlist) body.allow_waitlist = true;
    const r = await post('/reservations', body);
    p.id = r.id;
    p.status = r.status;
    if (p.cancel) await post(`/reservations/${r.id}/cancel`, { reason: 'Guest changed travel plans' });
  }
  log(`Reservations created (${plan.filter((p) => p.status === 'waitlisted').length} waitlisted, ${plan.filter((p) => p.hold).length} hold, ${plan.filter((p) => p.cancel).length} cancelled).`);

  // ------------------------------------------------- shared day-loop state
  const roomOcc = new Map(); // roomId -> plan entry
  const live = plan.filter((p) => !p.cancel && !p.waitlist && !p.hold);
  let totalCheckins = 0;
  let totalCheckouts = 0;
  const posStats = { tabs: 0, byDay: {}, revenue: 0 };
  const martStats = { sales: 0, revenue: 0 };

  async function folioFor(p) {
    const folios = await get(`/cashiering/reservations/${p.id}/folios`);
    return folios.find((f) => f.status === 'open') || folios[0];
  }

  const hotelAccounts = await get('/cashiering/terminal-account-options');
  async function settleFolio(p) {
    const folio = await folioFor(p);
    if (!folio) return;
    if (Number(folio.balance) <= 0) return;
    const amount = String(folio.balance);
    if (rand() < 0.62 && hotelAccounts.length) {
      await post(`/cashiering/folios/${folio.id}/payments/terminal`, { amount, currency: 'NGN', account_id: hotelAccounts[0].id, reference: `MP${ri(10000000, 99999999)}` });
    } else {
      await post(`/cashiering/folios/${folio.id}/payments/cash`, { amount, currency: 'NGN' });
    }
  }

  // POS helpers -------------------------------------------------------
  const wBar = [['Star Lager 60cl', 22], ['Heineken 33cl', 14], ['Gulder 60cl', 12], ['Guinness Stout', 9], ['Coca-Cola 50cl', 9], ['Chivita Active Juice', 6], ['Eva Water 75cl', 6], ['Fanta Orange 50cl', 5], ['Hennessy VS (shot)', 5], ['Chapman', 5], ['Mojito', 4], ['Red Wine (glass)', 3]];
  const wRest = [['Jollof Rice & Chicken', 22], ['Fried Rice & Turkey', 14], ['Egusi & Pounded Yam', 12], ['Pepper Soup (goat)', 12], ['Suya Platter', 14], ['Grilled Fish & Plantain', 8], ['Club Sandwich', 7], ['Moi-moi & Pap', 5], ['Fresh Fruit Platter', 4], ['Vanilla Ice Cream', 4]];

  async function posTab(outletKey, as, { room } = {}) {
    const catalogue = menuItems[outletKey];
    const weights = outletKey === 'bar' ? wBar : wRest;
    const lines = new Map();
    const nLines = outletKey === 'bar' ? ri(1, 4) : ri(1, 4);
    for (let i = 0; i < nLines; i += 1) {
      const name = weighted(weights);
      lines.set(name, (lines.get(name) || 0) + ri(1, outletKey === 'bar' ? 3 : 2));
    }
    const order = await post('/pos/orders', { outlet_id: outlets[outletKey], terminal_id: terminals[outletKey], table_label: outletKey === 'bar' ? `Bar ${ri(1, 14)}` : `Table ${ri(1, 16)}` }, { as });
    let subtotal = 0;
    for (const [name, qty] of lines) {
      const item = catalogue.find((m) => m.name === name);
      await post(`/pos/orders/${order.id}/items`, { menu_item_id: item.id, quantity: qty }, { as });
      subtotal += item.price * qty;
    }
    const settlement = {};
    const roll = rand();
    if (room && roll < 0.2) {
      settlement.method = 'room_charge';
      settlement.room_charge = { reservation_id: room.id, auth_method: 'signature', auth_reference: 'Signed at bar' };
    } else if (roll < 0.45) {
      settlement.method = 'cash';
    } else {
      const acct = pick(outletAccounts[outletKey]);
      settlement.method = 'terminal';
      settlement.terminal_account_id = acct.id;
      settlement.terminal_provider = acct.provider;
      settlement.terminal_reference = `${acct.provider.slice(0, 2).toUpperCase()}${ri(10000000, 99999999)}`;
    }
    if (outletKey === 'rest' && rand() < 0.3) settlement.service_charge = money(subtotal * 0.05);
    if (rand() < 0.22) settlement.tip_amount = money(pick([200, 300, 500, 1000]));
    let res = await post(`/pos/orders/${order.id}/settle`, { settlements: [settlement] }, { as, allowFail: settlement.method === 'room_charge' });
    if (res?.failed) {
      settlement.method = 'cash';
      delete settlement.room_charge;
      res = await post(`/pos/orders/${order.id}/settle`, { settlements: [settlement] }, { as });
    }
    const s = (res.settlements || [])[0] || {};
    return { method: settlement.method, total: Number(s.total_amount ?? s.amount ?? subtotal), cash: settlement.method === 'cash' };
  }

  // ------------------------------------------------------- the day loop
  log('Running 14 days of operations ...');
  const nightAuditSummaries = [];
  const dayCounts = {};
  const roomsFreeFor = (type) => roomsByType[type].filter((r) => !roomOcc.has(String(r.id)));
  // Supermarket is imported before day-loop sales begin (first day)
  let mart = null;

  for (let offset = -13; offset <= 0; offset += 1) {
    const date = D(offset);
    const isToday = offset === 0;
    // ---- supermarket import happens on the first day
    if (offset === -13) mart = await importMart(outlets.mart, terminals.mart);

    const startMarks = await markIds();
    // 1. incidental charges on in-house folios (restaurant/laundry/minibar)
    const inHouse = live.filter((p) => p.checkedIn && !p.checkedOut);
    for (const p of inHouse) {
      if (rand() < 0.22) {
        const folio = await folioFor(p);
        const [desc, amt] = pick([['Terrace Restaurant — dinner', ri(6, 22) * 1000], ['Laundry service', ri(3, 9) * 1000], ['Minibar', ri(2, 7) * 1000], ['Airport transfer', 25000]]);
        await post(`/cashiering/folios/${folio.id}/charges`, { type: 'pos_charge', description: desc, amount: money(amt) });
      }
    }
    // 2. departures
    if (!isToday) {
      for (const p of live.filter((x) => x.departure === offset && x.checkedIn && !x.checkedOut)) {
        await settleFolio(p);
        await post(`/reservations/${p.id}/check-out`, {});
        p.checkedOut = true;
        roomOcc.delete(String(p.roomId));
        totalCheckouts += 1;
      }
    } else {
      // today: one departing guest has paid part of the bill
      const dep = live.filter((x) => x.departure === 0 && x.checkedIn && !x.checkedOut);
      if (dep[0]) {
        const folio = await folioFor(dep[0]);
        const half = (Number(folio.balance) / 2).toFixed(2);
        if (Number(half) > 0) await post(`/cashiering/folios/${folio.id}/payments/cash`, { amount: half, currency: 'NGN' });
      }
    }
    // 3. check-ins (not today: today's arrivals are still waiting at the desk)
    if (!isToday) {
      for (const p of live.filter((x) => x.arrival === offset && !x.checkedIn)) {
        const free = roomsFreeFor(p.type);
        if (!free.length) throw new Error(`No free ${p.type} room for ${date}`);
        const room = free[ri(0, free.length - 1)];
        await post(`/reservations/${p.id}/check-in`, { room_id: room.id, override_dirty: true });
        p.checkedIn = true;
        p.roomId = room.id;
        roomOcc.set(String(room.id), p);
        totalCheckins += 1;
      }
    }
    // 4. POS: shifts + tabs
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 5 || dow === 6;
    const barTabs = isToday ? ri(4, 6) : ri(4, 7) + (weekend ? 3 : 0);
    const restTabs = isToday ? ri(3, 4) : ri(3, 5) + (weekend ? 2 : 0);
    const barShift = await post('/pos/shifts', { terminal_id: terminals.bar, opening_float: '20000.00' }, { as: 'bartender' });
    const restShift = await post('/pos/shifts', { terminal_id: terminals.rest, opening_float: '15000.00' }, { as: 'manager' });
    let barCash = 0;
    let restCash = 0;
    const roomCandidates = live.filter((p) => p.checkedIn && !p.checkedOut);
    for (let i = 0; i < barTabs; i += 1) {
      const r = await posTab('bar', 'bartender', { room: roomCandidates.length ? pick(roomCandidates) : null });
      if (r.cash) barCash += r.total;
      posStats.tabs += 1;
      posStats.revenue += r.total;
    }
    for (let i = 0; i < restTabs; i += 1) {
      const r = await posTab('rest', 'manager', { room: roomCandidates.length ? pick(roomCandidates) : null });
      if (r.cash) restCash += r.total;
      posStats.tabs += 1;
      posStats.revenue += r.total;
    }
    if (!isToday) {
      const variance = rand() < 0.3 ? -500 : 0;
      await post(`/pos/shifts/${barShift.id}/close`, { counted_cash: money(20000 + barCash + variance) }, { as: 'bartender' });
      await post(`/pos/shifts/${restShift.id}/close`, { counted_cash: money(15000 + restCash) }, { as: 'manager' });
    } else {
      await post(`/pos/shifts/${restShift.id}/close`, { counted_cash: money(15000 + restCash) }, { as: 'manager' }); // bar shift stays open today
    }
    // 5. supermarket sales
    const sales = isToday ? ri(8, 10) : ri(7, 12) + (weekend ? 3 : 0);
    for (let i = 0; i < sales; i += 1) await martSale(mart);
    // restock the bar mid-period
    if (offset === -6) await receiveAndTransfer(250, 100, 'GRN-LG-0002');
    // 6. the day ends: night audit rolls the business date
    if (!isToday) {
      const audit = await post('/night-audit/run', {});
      nightAuditSummaries.push({ date, revenue: audit?.room_revenue ?? audit?.roomRevenue });
    }
    // backdate this day's timestamps to the business date
    await backdate(startMarks, date);
    await quietOutbox();
    log(`  ${date}: in-house ${live.filter((p) => p.checkedIn && !p.checkedOut).length}, POS tabs ${barTabs + restTabs}, mart sales ${sales}`);
  }

  // ------------------------------------------------------- mart helpers
  async function importMart(outletId) {
    const products = martProducts();
    const csv = ['name,category,price,barcodes,unit,cost_price,opening_stock,reorder_level,supplier']
      .concat(products.map((p) => [`"${p.name}"`, p.category, p.price.toFixed(2), p.barcode, p.unit, p.cost.toFixed(2), p.stock, p.reorder, `"${p.supplier}"`].join(',')))
      .join('\n') + '\n';
    const res = await agent
      .post('/api/v1/supermarket/imports')
      .set('Authorization', `Bearer ${tokenFor(state.users.manager)}`)
      .set('Idempotency-Key', `demo-${RUN}-${(keyCounter += 1)}`)
      .field('outlet_id', String(outletId))
      .attach('file', Buffer.from(csv, 'utf8'), 'lagos-mart-products.csv');
    if (res.status !== 201) throw new Error(`import upload failed: ${res.status} ${JSON.stringify(res.body)}`);
    const run = res.body.data.run;
    if (res.body.data.summary.errors) throw new Error(`import has errors: ${JSON.stringify(res.body.data)}`);
    const c = await call('post', `/supermarket/imports/${run.id}/commit`, { body: {} });
    await runImportCommitJob({ tenantId: state.tenantId, importRunId: run.id });
    const status = (await knex('import_runs').where({ id: run.id }).first()).status;
    if (status !== 'completed') throw new Error(`import ended ${status}`);
    // resolve product ids by barcode
    const barcodes = await get('/supermarket/barcodes', { query: { outlet_id: outletId } });
    const byCode = new Map(barcodes.map((b) => [String(b.barcode), b]));
    const stockLeft = new Map();
    for (const p of products) {
      const b = byCode.get(p.barcode);
      p.menuItemId = b.menu_item_id;
      stockLeft.set(p.barcode, p.stock);
    }
    log(`Mart: imported ${products.length} products.`);
    return { outletId, terminalId: terminals.mart, products, stockLeft };
  }

  async function martSale(m, forceLines) {
    const lines = [];
    if (forceLines) lines.push(...forceLines);
    else {
      const n = weighted([[1, 30], [2, 35], [3, 22], [4, 10], [5, 3]]);
      const chosen = new Set();
      for (let i = 0; i < n; i += 1) {
        const p = weighted(m.products.map((x) => [x, x.weight]));
        if (chosen.has(p.barcode)) continue;
        chosen.add(p.barcode);
        const qty = p.unit === 'pcs' && rand() < 0.2 ? 2 : 1 + (rand() < 0.12 ? 1 : 0);
        const left = m.stockLeft.get(p.barcode);
        const floor = p.keepAbove;
        if (left - qty < floor) continue;
        lines.push({ p, qty });
      }
    }
    if (!lines.length) return;
    const method = rand() < 0.55 ? 'cash' : 'terminal';
    const body = { outlet_id: m.outletId, terminal_id: m.terminalId, method, items: lines.map((l) => ({ barcode: l.p.barcode, quantity: l.qty })) };
    if (method === 'terminal') {
      const acct = outletAccounts.mart[0];
      body.terminal_account_id = acct.id;
      body.terminal_provider = acct.provider;
      body.terminal_reference = `MP${ri(10000000, 99999999)}`;
    }
    const sale = await post('/supermarket/sales', body, { as: rand() < 0.5 ? 'manager' : 'bartender', allowFail: true });
    if (sale.failed) {
      // the bartender role may not hold supermarket.sales: retry as manager
      const again = await post('/supermarket/sales', body, { as: 'manager' });
      void again;
    }
    for (const l of lines) m.stockLeft.set(l.p.barcode, m.stockLeft.get(l.p.barcode) - l.qty);
    martStats.sales += 1;
  }

  function martProducts() {
    const prefix = '615';
    const eanCheck = (twelve) => {
      let sum = 0;
      for (let i = 0; i < 12; i += 1) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
      return (10 - (sum % 10)) % 10;
    };
    let seq = 100001;
    const mk = (category, name, price, cost, unit, supplier, weight = 5, lowStock = false) => {
      const twelve = `${prefix}${String(seq).padStart(9, '0')}`;
      seq += 137;
      const stock = lowStock ? ri(9, 14) : ri(40, 120);
      return {
        name, category, price, cost, unit, supplier, weight, stock,
        reorder: lowStock ? 10 : ri(10, 24),
        barcode: `${twelve}${eanCheck(twelve)}`,
        keepAbove: lowStock ? 2 : 6,
        low: lowStock,
      };
    };
    return [
      mk('Mart Soft Drinks', 'Coca-Cola 50cl', 400, 280, 'bottle', 'Coca-Cola Nigeria Ltd', 9),
      mk('Mart Soft Drinks', 'Pepsi 50cl', 400, 280, 'bottle', 'Seven-Up Bottling Co', 6),
      mk('Mart Soft Drinks', 'Fanta Orange 50cl', 400, 280, 'bottle', 'Coca-Cola Nigeria Ltd', 5),
      mk('Mart Soft Drinks', 'Eva Water 75cl', 250, 150, 'bottle', 'Eva Water', 10),
      mk('Mart Soft Drinks', 'Chivita Active 1L', 1300, 950, 'pack', 'Chi Limited', 5),
      mk('Mart Soft Drinks', 'Malta Guinness 33cl', 500, 350, 'bottle', 'Guinness Nigeria', 5, true),
      mk('Mart Soft Drinks', 'Lipton Yellow Label (25 bags)', 1500, 1100, 'box', 'Unilever Nigeria', 3),
      mk('Mart Groceries', 'Indomie Chicken Noodles 70g', 220, 160, 'pack', 'Dufil Prima Foods', 14),
      mk('Mart Groceries', 'Peak Milk Powder 400g', 3800, 3100, 'tin', 'FrieslandCampina WAMCO', 6),
      mk('Mart Groceries', 'Golden Penny Spaghetti 500g', 850, 650, 'pack', 'Flour Mills of Nigeria', 5),
      mk('Mart Groceries', 'Dangote Sugar 500g', 950, 780, 'pack', 'Dangote Sugar Refinery', 5),
      mk('Mart Groceries', 'Honeywell Semolina 1kg', 1800, 1450, 'pack', 'Honeywell Flour Mills', 3),
      mk('Mart Groceries', 'Power Oil Vegetable Oil 1L', 2600, 2150, 'bottle', 'PZ Wilmar', 4),
      mk('Mart Groceries', 'Kings Groundnut Oil 1L', 3100, 2600, 'bottle', 'Kings Oil', 2),
      mk('Mart Groceries', 'Gino Tomato Paste 70g', 280, 200, 'sachet', 'Erisco Foods', 8),
      mk('Mart Groceries', 'Maggi Star Cubes (pack)', 350, 260, 'pack', 'Nestle Nigeria', 9),
      mk('Mart Groceries', 'Nasco Cornflakes 350g', 2400, 1900, 'box', 'Nasco Foods', 3, true),
      mk('Mart Groceries', 'Cabin Biscuits 200g', 600, 440, 'pack', 'Lagos Biscuits', 4),
      mk('Mart Toiletries', 'Close-Up Toothpaste 120g', 1100, 800, 'tube', 'Unilever Nigeria', 6),
      mk('Mart Toiletries', 'Dettol Soap 100g', 700, 520, 'bar', 'Reckitt Benckiser', 5),
      mk('Mart Toiletries', 'Dove Body Wash 250ml', 3400, 2700, 'bottle', 'Unilever Nigeria', 3, true),
      mk('Mart Toiletries', 'Colgate Toothbrush', 650, 450, 'pcs', 'Colgate-Palmolive', 5),
      mk('Mart Toiletries', 'Nivea Body Lotion 400ml', 4800, 3900, 'bottle', 'Beiersdorf Nigeria', 3),
      mk('Mart Toiletries', 'Always Pads (8 pack)', 1200, 900, 'pack', 'Procter & Gamble', 4),
      mk('Mart Toiletries', 'Rexona Roll-on 50ml', 1900, 1500, 'pcs', 'Unilever Nigeria', 4),
      mk('Mart Household', 'Omo Detergent 500g', 1450, 1100, 'pack', 'Unilever Nigeria', 5),
      mk('Mart Household', 'Harpic Toilet Cleaner 500ml', 2200, 1750, 'bottle', 'Reckitt Benckiser', 2),
      mk('Mart Household', 'Jik Bleach 500ml', 1100, 820, 'bottle', 'Reckitt Benckiser', 3),
      mk('Mart Household', 'Duracell AA Batteries (4)', 2500, 1900, 'pack', 'Duracell Nigeria', 3),
      mk('Mart Household', 'Tissue Roll (4 pack)', 1600, 1200, 'pack', 'Kleenex Nigeria', 4),
      mk('Mart Household', 'Rid Insecticide Spray 300ml', 2800, 2200, 'can', 'Reckitt Benckiser', 2, true),
      mk('Mart Snacks', 'Pringles Original 165g', 3600, 2900, 'can', 'Kellogg Company', 4),
      mk('Mart Snacks', 'Lays Classic Chips 40g', 700, 500, 'pack', 'PepsiCo Nigeria', 7),
      mk('Mart Snacks', 'Gala Sausage Roll', 350, 240, 'pcs', 'UAC Foods', 11),
      mk('Mart Snacks', 'Cadbury Dairy Milk 45g', 900, 680, 'bar', 'Mondelez Nigeria', 6),
      mk('Mart Snacks', 'Kinder Joy', 1500, 1150, 'pcs', 'Ferrero', 3),
      mk('Mart Snacks', 'Cashew Nuts 100g', 1800, 1400, 'pack', 'Lagos Nuts', 3),
      mk('Mart Snacks', 'Chin Chin (pack)', 700, 450, 'pack', 'Mama Titi Foods', 6),
      mk('Mart Snacks', 'Plantain Chips 80g', 600, 400, 'pack', 'Mama Titi Foods', 5),
    ];
  }

  // low-stock tuning for the mart (bring flagged products to or below reorder, never zero)
  const lowMarks = await markIds();
  for (const p of mart.products.filter((x) => x.low)) {
    const left = mart.stockLeft.get(p.barcode);
    const sellQty = left - (p.reorder - ri(2, 4)); // end a few units under reorder
    if (sellQty > 0) {
      let remaining = sellQty;
      while (remaining > 0) {
        const q = Math.min(remaining, ri(1, 3));
        await martSale(mart, [{ p, qty: q }]);
        remaining -= q;
      }
    }
  }
  await backdate(lowMarks, today); // low-stock sales belong to today

  // -------------------------------------------------- housekeeping & rest
  log('Housekeeping, expenses, AR ...');
  const roomsNow = await get('/rooms');
  const occupiedRoomIds = new Set(live.filter((p) => p.checkedIn && !p.checkedOut).map((p) => String(p.roomId)));
  // recently checked-out rooms are dirty; a few more dirty for the board
  const lastOut = live.filter((p) => p.checkedOut && p.departure >= -1).map((p) => String(p.roomId));
  const dirtyExtra = new Set(lastOut);
  for (const room of roomsNow) {
    const occupied = occupiedRoomIds.has(String(room.id));
    const dirty = dirtyExtra.has(String(room.id)) || (!occupied && rand() < 0.1);
    await post(`/housekeeping/rooms/${room.id}/status`, { cleanliness: dirty ? 'dirty' : 'clean', occupancy_observed: occupied ? 'occupied' : 'vacant' });
  }
  const dirtyRooms = (await get('/rooms')).filter((r) => r.housekeeping_reported_status === 'dirty');
  let assignIdx = 0;
  const assignments = [];
  for (const room of dirtyRooms.slice(0, 6)) {
    const attendant = assignIdx % 2 === 0 ? state.users.hk1 : state.users.hk2;
    assignIdx += 1;
    const a = await post('/housekeeping/assignments', { room_id: String(room.id), attendant_user_id: String(attendant), business_date: today });
    assignments.push(a);
  }
  for (const a of assignments.slice(0, 2)) await patch(`/housekeeping/assignments/${a.id}`, { status: 'in_progress' }, { allowFail: true });
  // Out-of-order period in the future on a room not used in the next week
  const oooCandidate = roomsByType.DLX.find((r) => !plan.some((p) => p.roomId === r.id && p.departure >= 0));
  if (oooCandidate) {
    const r = await post('/housekeeping/out-of-order', { room_id: oooCandidate.id, type: 'ooo', reason: 'Air-conditioning replacement', start_date: D(6), end_date: D(8) }, { allowFail: true });
    if (r?.failed) log('  (out-of-order failed:', JSON.stringify(r.error), ')');
  }

  // Expenses
  const expCats = {};
  for (const name of ['Utilities', 'Salaries & Wages', 'Maintenance', 'Supplies', 'Marketing']) expCats[name] = (await post('/expenses/categories', { name })).id;
  const expenseList = [
    ['Utilities', 'Diesel for generator', 'Total Energies Filling Station', 185000, 'bank_transfer', -12],
    ['Utilities', 'EKEDC electricity bill', 'Eko Electricity Distribution', 312500, 'bank_transfer', -9],
    ['Utilities', 'Water treatment & delivery', 'Lagos Water Corporation', 64000, 'cash', -4],
    ['Salaries & Wages', 'Housekeeping staff wages (fortnight)', 'Staff payroll', 480000, 'bank_transfer', -7],
    ['Maintenance', 'Plumbing repairs, floor 2', 'Adewale Plumbing Works', 92000, 'cash', -10],
    ['Maintenance', 'Lift servicing', 'OTIS Nigeria', 210000, 'bank_transfer', -6],
    ['Supplies', 'Guest toiletries restock', 'Lagos Hospitality Supplies', 138500, 'bank_transfer', -11],
    ['Supplies', 'Linen and towels', 'Textile House Ikeja', 275000, 'card', -5],
    ['Marketing', 'Google & Instagram ads', 'Meta / Google', 95000, 'card', -8],
    ['Marketing', 'Website hosting', 'Planmsys', 28000, 'card', -3],
  ];
  for (const [cat, description, payee, amount, method, off] of expenseList) {
    await post('/expenses', { expense_category_id: expCats[cat], description, payee, amount: money(amount), currency: 'NGN', payment_method: method, business_date: D(off) });
  }
  await post('/expenses/recurring-schedules', { expense_category_id: expCats['Salaries & Wages'], description: 'Monthly management salaries', payee: 'Staff payroll', amount: '1250000.00', currency: 'NGN', payment_method: 'bank_transfer', frequency: 'monthly', day_of_month: 28, start_date: D(12) }, { allowFail: true });

  // AR: a corporate account with an invoice-able folio (best-effort)
  try {
    const company = await post('/companies', { name: 'Lagoon Freight & Logistics Ltd', billing_email: 'accounts@lagoonfreight.example.com', billing_phone: '+234 1 270 5500', payment_terms_days: 30 });
    await post('/ar/accounts', { company_profile_id: company.id, currency: 'NGN', credit_limit: '2000000.00', enforcement_mode: 'flag_only' });
  } catch (e) {
    log('  (AR skipped:', e.message.slice(0, 120), ')');
  }

  // ------------------------------------------------- clean the top bar
  await quietOutbox();
  // The running dev backend's 5-minute "departing today with a balance" sweep writes bell rows for
  // this tenant too. Wait (up to ~5.5 min) for its first pass so its dedup rows exist, then mark every
  // bell row read and non-popup: the top bar is clean and the sweep will not re-raise them.
  const bellWaitStart = Date.now();
  while (Date.now() - bellWaitStart < 330000) {
    const [[row]] = await knex.raw("select count(*) c from in_app_notifications where tenant_id = ? and type = 'front_desk.departing_balance_outstanding'", [state.tenantId]);
    if (Number(row.c) > 0) break;
    await sleep(10000);
  }
  // Everything except the sweep's dedup rows is deleted; those few are kept (read) so the sweep never re-raises them.
  await knex('in_app_notifications').where({ tenant_id: state.tenantId }).whereNot({ type: 'front_desk.departing_balance_outstanding' }).delete();
  await knex('in_app_notifications').where({ tenant_id: state.tenantId }).update({ read_at: knex.fn.now(), popup: 0 });
  const finalProp = await knex('properties').where({ id: state.propertyId }).first();

  // ------------------------------------------------------------ report
  log('\n================ SUMMARY ================');
  log(`Business date: ${finalProp.current_business_date} (today ${today}) -> ${String(finalProp.current_business_date).slice(0, 10) === today || new Date(finalProp.current_business_date).toISOString().slice(0, 10) === today ? 'OK' : 'MISMATCH'}`);
  const counts = {};
  for (const table of ['guests', 'rooms', 'reservations', 'folio_line_items', 'payments', 'pos_orders', 'pos_order_settlements', 'pos_menu_items', 'stock_items', 'stock_movements', 'supermarket_sales', 'expenses', 'night_audit_runs', 'daily_reports', 'pos_shifts']) {
    const [[row]] = await knex.raw(`select count(*) c from \`${table}\` where tenant_id = ?`, [state.tenantId]);
    counts[table] = Number(row.c);
  }
  log('Row counts:', JSON.stringify(counts));
  const after = await snapshotOthers();
  const diffs = Object.keys(before).filter((t) => before[t] !== after[t]).map((t) => `${t}: ${before[t]} -> ${after[t]}`);
  log(diffs.length ? `Other tenants' rows changed (may be live dev traffic): ${diffs.join('; ')}` : 'Other tenants: all table row counts identical before/after.');
  log(`\nLogin (password ${DEV_PASSWORD}):`);
  log('  demo@lagos-grand.example.com     (super_admin, MFA off for this property)');
  log('  manager@lagos-grand.example.com  (manager, every permission)');
  log(`  URL: http://${DEMO_SLUG}.localhost:5173`);
}

// ---------------------------------------------- timestamp back-dating helpers
// Business logic stamps real "now"; the demo spreads those rows over the day
// by moving the timestamps of rows created since `marks` to the business date.
const TS_TABLES = [
  ['pos_order_settlements', ['settled_at']],
  ['pos_orders', ['opened_at', 'closed_at']],
  ['pos_order_items', ['created_at']],
  ['supermarket_sales', ['created_at']],
  ['stock_movements', ['occurred_at', 'created_at']],
  ['pos_shifts', ['opened_at', 'closed_at']],
  ['payments', ['created_at', 'captured_at']],
  ['folio_line_items', ['created_at']],
  ['audit_log', ['occurred_at']],
];
async function markIds() {
  const marks = {};
  for (const [table] of TS_TABLES) {
    const [[row]] = await knex.raw(`select coalesce(max(id),0) m from \`${table}\``);
    marks[table] = Number(row.m);
  }
  return marks;
}
const colCache = {};
async function hasColumn(table, col) {
  const key = `${table}.${col}`;
  if (colCache[key] === undefined) {
    const [rows] = await knex.raw('select 1 from information_schema.columns where table_schema = database() and table_name = ? and column_name = ?', [table, col]);
    colCache[key] = rows.length > 0;
  }
  return colCache[key];
}
async function backdate(marks, date) {
  for (const [table, cols] of TS_TABLES) {
    for (const col of cols) {
      if (!(await hasColumn(table, col))) continue;
      // keep NULLs (e.g. an open shift's closed_at) and only touch this tenant's new rows
      await knex.raw(
        `update \`${table}\` set \`${col}\` = timestamp(?, sec_to_time(? + floor(rand() * ?))) where id > ? and tenant_id = ? and \`${col}\` is not null`,
        [date, 8 * 3600, 12 * 3600, marks[table] || 0, state.tenantId]
      );
    }
  }
}

main()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('FAILED:', error.stack || error);
    try {
      await quietOutbox();
      await knex.destroy();
    } catch (e) {
      /* ignore */
    }
    process.exit(1);
  });
