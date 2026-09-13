'use strict';

/**
 * Two photo uploads for the same menu item at the same moment, over real
 * pooled connections (the shared-transaction harness every other test file
 * uses cannot prove a row lock — see `tests/pos/concurrency.test.js`).
 * Without the row lock in `setMenuItemImage`, both uploads read the same
 * "previous photo", each deletes only that one, and the losing upload's new
 * file stays on disk with nothing pointing at it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

describe('menu item photo uploads under real concurrent connections', () => {
  let req;
  let storage;
  let tenantId;
  let propertyId;
  let userId;
  let roleId;
  let menuItemId;
  let token;

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-menu-images-race-'));
    process.env.MENU_IMAGE_STORAGE_DIR = storage;
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Image Race Tenant', slug: `image-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({ tenant_id: tenantId, slug: `image-race-property-${suffix}`, name: 'Image Race Property', timezone: 'Africa/Lagos', base_currency: 'NGN' });
    [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({ tenant_id: tenantId, email: `image-race-${suffix}@example.com`, password_hash: `$2b$12$${'x'.repeat(53)}`, first_name: 'Image', last_name: 'Manager', status: 'active' });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });
    const perms = await db()('permissions').where({ permission_key: 'pos.manage' }).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
    const [outletId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'RACE-IMG', name: 'Race Bar', type: 'bar' });
    [menuItemId] = await db()('pos_menu_items').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, name: 'Race Item', category: 'Drinks', price: '15.00' });
    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('pos_menu_items').where({ tenant_id: tenantId }).delete();
    await db()('pos_outlets').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
    delete process.env.MENU_IMAGE_STORAGE_DIR;
    fs.rmSync(storage, { recursive: true, force: true });
  });

  it('leaves exactly one file on disk — the one the item points at', async () => {
    const upload = (buffer, name) => req.post(`/api/v1/pos/menu-items/${menuItemId}/image`).set('Authorization', `Bearer ${token}`).attach('image', buffer, name);
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all([upload(PNG, 'a.png'), upload(JPEG, 'b.jpg'), upload(PNG, 'c.png')]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    }
    // File removal is best-effort and asynchronous.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = (await db()('pos_menu_items').where({ id: menuItemId }).first()).image_path;
    expect(fs.readdirSync(storage)).toEqual([current]);
  });
});
