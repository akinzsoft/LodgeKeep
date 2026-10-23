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
  await patch(`/properties/${property.id}`, { current_business_date: today });
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

  // Guests (fictional) and one upcoming booking
  const guests = [];
  for (const [first, last] of [['Alex', 'Sample'], ['Jordan', 'Example'], ['Taylor', 'Placeholder'], ['Robin', 'Demo-Guest']]) {
    guests.push(await post('/guests', { first_name: first, last_name: last, email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com' }));
  }
  const types = await get('/room-types');
  const std = types.find((t) => t.code === 'STD');
  const rates = await get('/rate-codes');
  await post('/reservations', {
    guest_id: guests[0].id,
    room_type_id: std.id,
    rate_code_id: rates.find((r) => r.code === 'RACK-STD').id,
    arrival_date: addDays(today, 1),
    departure_date: addDays(today, 3),
    adults: 2,
  });

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
