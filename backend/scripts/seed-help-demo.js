'use strict';

/**
 * DEV-ONLY demo hotel for the Help guides' screenshots: "Palm Grove Demo
 * Hotel" (tenant slug `demo-help`). Everything in it is plainly fictional:
 * made-up names on example.com addresses, no phone numbers, no bank accounts
 * or account numbers, no payment provider, no real businesses.
 *
 *   cd backend && node scripts/seed-help-demo.js           # build (no-op if it exists)
 *   cd backend && node scripts/seed-help-demo.js --reset   # delete ONLY this tenant, rebuild
 *
 * Logins (password = the repo's published dev password):
 *   admin@palm-grove.example.com     super_admin (admin sign-in code switched off for the demo)
 *   manager@palm-grove.example.com   manager
 *
 * Refuses to run unless the environment is a local development one (see
 * scripts/lib/dev-only-guard.js: NODE_ENV not production, DB_NAME exactly
 * lodgekeep_dev, local DB host, no real app domain, no real email provider,
 * no live Paystack key). Queues are stubbed and every outbox row is marked
 * sent, so nothing can be emailed.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ quiet: true });

const { assertDevelopmentOnly } = require('./lib/dev-only-guard');
assertDevelopmentOnly();

require('../src/jobs/outbox-dispatcher').enqueueOutboxDispatch = async () => {};

const request = require('supertest');
const knexLib = require('knex');
const knexConfig = require('../knexfile.js');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/auth/tokens');
const { hashPassword } = require('../src/auth/password');
const { signupTenant } = require('../src/modules/signup/service');
const { calendarDateInZone } = require('../src/shared/timezone');
const { TENANT_PURGE_ORDER, SELF_REFERENCES } = require('../src/modules/offboarding/purge-plan');

const SLUG = 'demo-help';
const PASSWORD = 'LodgeKeepDev123!';
const knex = knexLib(knexConfig.development);
const RESET = process.argv.includes('--reset');
const RUN = Date.now().toString(36);
let keys = 0;
const state = { tenantId: null, propertyId: null, users: {} };
const agent = request(createApp());

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function call(method, url, body, as = 'manager') {
  const token = signAccessToken({ aud: 'staff', sub: String(state.users[as]), tenant_id: String(state.tenantId), property_id: String(state.propertyId) });
  let req = agent[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
  if (method !== 'get') req = req.set('Idempotency-Key', `help-${RUN}-${(keys += 1)}`);
  const res = await (body === undefined ? req : req.send(body));
  if (res.status >= 400) throw new Error(`${method.toUpperCase()} ${url} -> ${res.status} ${JSON.stringify(res.body?.error)}`);
  return res.body.data;
}
const get = (url, as) => call('get', url, undefined, as);
const post = (url, body, as) => call('post', url, body, as);
const patch = (url, body, as) => call('patch', url, body, as);

async function removeTenant(tenantId) {
  await knex.raw('set session sql_safe_updates = 0');
  for (const table of TENANT_PURGE_ORDER) {
    const selfRef = SELF_REFERENCES[table];
    if (selfRef) await knex(table).where({ tenant_id: tenantId }).update({ [selfRef]: null });
    for (;;) {
      const [res] = await knex.raw(`delete from \`${table}\` where tenant_id = ? limit 2000`, [tenantId]);
      if (!res.affectedRows) break;
    }
  }
  await knex('tenant_signups').where({ tenant_id: tenantId }).delete();
  await knex('tenants').where({ id: tenantId }).delete();
}


/** Runs one optional demo section: a failure is reported and the rest of the seed carries on. */
async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    console.warn(`  WARN  ${name}: ${error.message}`);
    return null;
  }
}

/** Guests, reservations in every state, folios, a company account, a group block, three real Night Audits. */
async function seedStays(today, bar) {
  const guests = [];
  for (const [first, last] of [['Alex', 'Sample'], ['Jordan', 'Example'], ['Taylor', 'Placeholder'], ['Robin', 'Demo-Guest'], ['Morgan', 'Fictional'], ['Casey', 'Testcase']]) {
    guests.push(await post('/guests', { first_name: first, last_name: last, email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com' }));
  }
  const types = await get('/room-types');
  const std = types.find((t) => t.code === 'STD');
  const dlx = types.find((t) => t.code === 'DLX');
  const rates = await get('/rate-codes');
  const rate = (code) => rates.find((r) => r.code === `RACK-${code}`).id;
  const rooms = await get('/rooms');
  const roomId = (n) => rooms.find((r) => r.room_number === n).id;
  const book = (guest, type, from, to, extra = {}) =>
    post('/reservations', { guest_id: guest.id, room_type_id: type.id, rate_code_id: rate(type.code), arrival_date: addDays(today, from), departure_date: addDays(today, to), adults: 2, ...extra });
  const folioOf = async (reservationId) => (await get(`/cashiering/reservations/${reservationId}/folios`))[0];
  const cash = (folio, amount) => post(`/cashiering/folios/${folio.id}/payments/cash`, { amount, currency: 'NGN' });

  // Checked out: stayed one night, paid in full.
  const r1 = await book(guests[0], std, -3, -2);
  await post(`/reservations/${r1.id}/open-folio`, {});
  await post(`/reservations/${r1.id}/check-in`, { room_id: roomId('101'), override_dirty: true });
  const f1 = await folioOf(r1.id);
  await cash(f1, (await get(`/cashiering/folios/${f1.id}`)).balance ?? '32250.00');
  await post(`/reservations/${r1.id}/check-out`, {});

  // In house: stays past today, partly paid, with a bar charge.
  const r2 = await book(guests[1], dlx, -3, 2);
  await post(`/reservations/${r2.id}/check-in`, { room_id: roomId('201'), override_dirty: true });
  const f2 = await folioOf(r2.id);
  await post(`/cashiering/folios/${f2.id}/charges`, { type: 'pos_charge', description: 'Bar tab, Palm Bar', amount: '4500.00', currency: 'NGN' });

  // In house, leaves today, folio billed to a company account.
  const r3 = await book(guests[2], std, -3, 0);
  await post(`/reservations/${r3.id}/check-in`, { room_id: roomId('102'), override_dirty: true });
  const company = await step('company profile', () => post('/companies', { name: 'Sample Holdings Ltd', type: 'company', billing_email: 'accounts@sample-holdings.example.com', payment_terms_days: 30 }));
  let arAccount = null;
  if (company) {
    arAccount = await step('AR account', () => post('/ar/accounts', { company_profile_id: company.id, currency: 'NGN', credit_limit: '500000.00', enforcement_mode: 'block' }));
    await step('link guest to company', () => post(`/guests/${guests[2].id}/link-company`, { company_profile_id: company.id }));
    if (arAccount) await step('bill folio to company', async () => post(`/cashiering/folios/${(await folioOf(r3.id)).id}/bill-to-account`, { company_profile_id: company.id }));
  }

  // Upcoming, arriving today, a hold, and a cancelled booking.
  await book(guests[0], std, 1, 3);
  await book(guests[4], dlx, 0, 2);
  await step('hold', () => book(guests[5], std, 4, 6, { as_hold: true }));
  const cancelled = await book(guests[3], std, 5, 7);
  await post(`/reservations/${cancelled.id}/cancel`, { reason: 'Guest changed plans (demo)' });

  // A group block with a rooming-list booking.
  const block = await step('group block', () =>
    post('/group-blocks', { block_name: 'Demo Wedding Party', company_profile_id: company?.id ?? null, start_date: addDays(today, 10), end_date: addDays(today, 12), cutoff_date: addDays(today, 5), notes: 'Fictional group for the Help screenshots' }),
  );
  if (block) {
    await step('block rooms', () => post(`/group-blocks/${block.id}/rooms`, { room_type_id: std.id, rooms_blocked: 3, start_date: addDays(today, 10), end_date: addDays(today, 12) }));
    await step('block booking', () => book(guests[4], std, 10, 12, { group_block_id: block.id }));
  }

  // Three real Night Audits roll the business date from three days ago to today.
  for (let i = 0; i < 3; i += 1) await step(`night audit ${i + 1}`, () => post('/night-audit/run', {}));

  // After the audits: payments, invoice, housekeeping, an out-of-order room.
  await cash(f2, '30000.00');
  if (arAccount) {
    const invoice = await step('AR invoice', () => post(`/ar/accounts/${arAccount.id}/invoices`, {}));
    if (invoice) await step('AR payment', () => post(`/ar/accounts/${arAccount.id}/payments`, { amount: '20000.00', currency: 'NGN', method_label: 'Bank transfer', received_at: today, reference: 'DEMO-REMIT-001' }));
  }
  const attendants = await get('/housekeeping/attendants');
  const attendant = attendants[0]?.id ?? state.users.housekeeper;
  for (const n of ['103', '104']) await step(`assign ${n}`, () => post('/housekeeping/assignments', { room_id: roomId(n), attendant_user_id: attendant, business_date: today }));
  await step('room clean', () => post(`/housekeeping/rooms/${roomId('105')}/status`, { cleanliness: 'clean', occupancy_observed: 'vacant' }));
  await step('discrepancy', () => post(`/housekeeping/rooms/${roomId('104')}/status`, { cleanliness: 'dirty', occupancy_observed: 'occupied' }));
  await step('out of order', () => post('/housekeeping/out-of-order', { room_id: roomId('106'), type: 'ooo', reason: 'Air conditioner repair (demo)', start_date: today, end_date: addDays(today, 3) }));
}

/** POS sales and shifts, stock, expenses, a small supermarket. */
async function seedExtras(today, bar) {
  const terminals = await get('/pos/terminals');
  const terminal = terminals[0];
  const items = await get(`/pos/menu-items?outlet_id=${bar.id}`);
  const item = (name) => items.find((i) => i.name === name).id;
  const sell = async (label, lines, settle) => {
    const order = await post('/pos/orders', { outlet_id: bar.id, terminal_id: terminal.id, table_label: label }, 'bartender');
    for (const [name, quantity] of lines) await post(`/pos/orders/${order.id}/items`, { menu_item_id: item(name), quantity }, 'bartender');
    if (settle) await post(`/pos/orders/${order.id}/settle`, { settlements: [settle] }, 'bartender');
    return order;
  };
  await step('first shift', async () => {
    await post('/pos/shifts', { terminal_id: terminal.id, opening_float: '10000.00' }, 'bartender');
    await sell('Table 1', [['Demo Lager', 2], ['Bottled Water', 1]], { method: 'terminal', terminal_provider: 'other', terminal_reference: 'DEMO-0001' });
    await sell('Table 2', [['House Cocktail', 2]], { method: 'cash' });
    const shifts = await get('/pos/shifts');
    await post(`/pos/shifts/${shifts[0].id}/close`, { counted_cash: '18050.00' }, 'bartender');
  });
  await step('second shift and open tab', async () => {
    await post('/pos/shifts', { terminal_id: terminal.id, opening_float: '10000.00' }, 'bartender');
    await sell('Table 4', [['Soft Drink', 3], ['Demo Lager', 1]], null);
  });

  await step('expenses', async () => {
    const cat = await post('/expenses/categories', { name: 'Utilities' });
    await post('/expenses/categories', { name: 'Maintenance' });
    await post('/expenses', { expense_category_id: cat.id, description: 'Generator fuel (demo)', amount: '85000.00', currency: 'NGN', payment_method: 'cash', payee: 'Demo Fuel Supplier' });
    await post('/expenses/recurring-schedules', { expense_category_id: cat.id, description: 'Internet subscription (demo)', amount: '25000.00', currency: 'NGN', payment_method: 'bank_transfer', frequency: 'monthly', day_of_month: 1, start_date: addDays(today, -20) });
  });

  await step('stock', async () => {
    const outlets = await get('/pos/outlets');
    const store = outlets.find((o) => o.type === 'store');
    const lager = await post('/pos/stock/items', { outlet_id: bar.id, name: 'Demo Lager (bottle)', unit: 'bottle', purchase_cost: '900.00', reorder_level: '12' });
    const water = await post('/pos/stock/items', { outlet_id: bar.id, name: 'Bottled Water (bottle)', unit: 'bottle', purchase_cost: '150.00', reorder_level: '24' });
    await post('/pos/stock/goods-received', { outlet_id: store.id, lines: [{ stock_item_id: lager.id, quantity: '96', unit_cost: '900.00' }, { stock_item_id: water.id, quantity: '120', unit_cost: '150.00' }] });
    await post('/pos/stock/transfers', { stock_item_id: lager.id, from_outlet_id: store.id, to_outlet_id: bar.id, quantity: '24', note: 'Weekly bar top-up (demo)' });
    await post('/pos/stock/transfer-requests', { from_outlet_id: store.id, to_outlet_id: bar.id, lines: [{ stock_item_id: water.id, quantity: '48' }], note: 'Bar is running low on water (demo)' });
    await post(`/pos/stock/items/${lager.id}/wastage`, { outlet_id: bar.id, quantity: '2', reason: 'Broken in the bar (demo)' });
    await post('/pos/stock/takes', { outlet_id: bar.id });
  });

  await step('supermarket', async () => {
    const mart = await post('/pos/outlets', { code: 'MART', name: 'Palm Mini Mart', type: 'supermarket' });
    await post('/pos/terminals', { outlet_id: mart.id, device_ref: 'PALM-MART-TILL-1', supports_contactless: false });
    await post('/pos/menu-categories', { name: 'Groceries', outlet_ids: [mart.id] });
    let n = 0;
    for (const [name, price] of [['Demo Biscuits', '600.00'], ['Demo Juice 1L', '1200.00'], ['Demo Bread Loaf', '1000.00']]) {
      const created = await post('/pos/menu-items', { outlet_id: mart.id, name, category: 'Groceries', price });
      n += 1;
      await post('/supermarket/barcodes', { menu_item_id: created.id, barcode: `0000000000${n}7` });
    }
    const list = await get(`/pos/menu-items?outlet_id=${mart.id}`);
    await post('/supermarket/sales', { outlet_id: mart.id, items: [{ menu_item_id: list[0].id, quantity: 2 }, { menu_item_id: list[1].id, quantity: 1 }], method: 'cash', confirm_oversell: true });
  });
}

async function main() {
  const existing = await knex('tenants').where({ slug: SLUG }).first();
  if (existing && !RESET) {
    console.log(`Tenant ${SLUG} already exists (id ${existing.id}). Pass --reset to rebuild it. Nothing changed.`);
    return;
  }
  if (existing) await removeTenant(existing.id);

  const today = calendarDateInZone(new Date(), 'Africa/Lagos');
  await signupTenant({
    companyName: 'Palm Grove Demo Hotels',
    slug: SLUG,
    timezone: 'Africa/Lagos',
    baseCurrency: 'NGN',
    propertyName: 'Palm Grove Demo Hotel',
    adminEmail: 'admin@palm-grove.example.com',
    adminPassword: PASSWORD,
    adminFirstName: 'Demo',
    adminLastName: 'Owner',
  });
  const tenant = await knex('tenants').where({ slug: SLUG }).first();
  const property = await knex('properties').where({ tenant_id: tenant.id }).first();
  state.tenantId = tenant.id;
  state.propertyId = property.id;
  state.users.admin = (await knex('users').where({ tenant_id: tenant.id, email: 'admin@palm-grove.example.com' }).first()).id;
  await knex('tenants').where({ id: tenant.id }).update({ status: 'active', trial_ends_at: null });
  await knex('properties').where({ id: property.id }).update({ mfa_required_for_admin_roles: false });

  const hash = await hashPassword(PASSWORD);
  for (const [key, email, first, last, role] of [
    ['manager', 'manager@palm-grove.example.com', 'Sam', 'Manager', 'manager'],
    ['frontdesk', 'frontdesk@palm-grove.example.com', 'Frankie', 'Frontdesk', 'front_desk'],
    ['cashier', 'cashier@palm-grove.example.com', 'Casey', 'Cashier', 'cashier'],
    ['housekeeper', 'housekeeper@palm-grove.example.com', 'Harper', 'Housekeeper', 'housekeeping'],
    ['bartender', 'bartender@palm-grove.example.com', 'Bobby', 'Bartender', 'pos_operator'],
  ]) {
    const [id] = await knex('users').insert({ tenant_id: tenant.id, email, password_hash: hash, first_name: first, last_name: last, status: 'active' });
    await knex('user_property_access').insert({ tenant_id: tenant.id, property_id: property.id, user_id: id, role });
    state.users[key] = id;
  }
  // The demo manager holds every permission so one login can reach every screen.
  const role = await knex('roles').where({ tenant_id: tenant.id, code: 'manager' }).first();
  const have = new Set((await knex('role_permissions').where({ tenant_id: tenant.id, role_id: role.id }).select('permission_id')).map((r) => String(r.permission_id)));
  const grants = (await knex('permissions').select('id')).filter((p) => !have.has(String(p.id))).map((p) => ({ tenant_id: tenant.id, role_id: role.id, permission_id: p.id }));
  if (grants.length) await knex('role_permissions').insert(grants);

  // Property, rooms, rates, tax
  // Start three days back: the demo runs real Night Audits below, which roll it forward to today.
  await patch(`/properties/${property.id}`, { current_business_date: addDays(today, -3) });
  const from = addDays(today, -365);
  for (const t of [
    { code: 'STD', name: 'Standard Room', rate: '30000.00', first: '101', last: '106', floor: 1 },
    { code: 'DLX', name: 'Deluxe Room', rate: '45000.00', first: '201', last: '204', floor: 2 },
  ]) {
    const rateCode = await post('/rate-codes', { code: `RACK-${t.code}`, description: `${t.name} standard rate`, base_rate: t.rate, currency: 'NGN', valid_from: from });
    const type = await post('/room-types', { code: t.code, name: t.name, description: `${t.name} (demo)`, default_occupancy: 2, base_rate: t.rate, primary_rate_code_id: rateCode.id });
    await post('/rooms/bulk', { room_type_id: type.id, floor: t.floor, from: t.first, to: t.last });
  }
  await post('/taxes', { tax_code: 'VAT', name: 'VAT 7.5%', rate: '7.5', effective_from: from, is_inclusive: false, calculation_method: 'percentage', applies_to: 'all', jurisdiction: 'Demo' });

  // Outlets, terminal, menu
  const bar = await post('/pos/outlets', { code: 'BAR', name: 'Palm Bar', type: 'bar' });
  await post('/pos/outlets', { code: 'STORE', name: 'Demo Store Room', type: 'store' });
  await post('/pos/terminals', { outlet_id: bar.id, device_ref: 'PALM-BAR-TILL-1', supports_contactless: false });
  await post('/pos/menu-categories', { name: 'Drinks', outlet_ids: [bar.id] });
  for (const [name, price] of [['Bottled Water', '500.00'], ['Soft Drink', '800.00'], ['Demo Lager', '1500.00'], ['House Cocktail', '3500.00']]) {
    await post('/pos/menu-items', { outlet_id: bar.id, name, category: 'Drinks', price });
  }

  await seedStays(today, bar);
  await seedExtras(today, bar);

  await knex('outbox_events').where({ tenant_id: tenant.id }).whereIn('status', ['pending', 'processing', 'failed']).update({ status: 'sent', processed_at: knex.fn.now() });
  console.log(`Demo hotel ready: http://${SLUG}.localhost:5173`);
  console.log(`  admin@palm-grove.example.com / manager@palm-grove.example.com  (password ${PASSWORD})`);
}

main()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('FAILED:', error.stack || error);
    await knex.destroy().catch(() => {});
    process.exit(1);
  });
