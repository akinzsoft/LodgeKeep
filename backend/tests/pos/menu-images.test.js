'use strict';

/**
 * Menu item photos: upload (`pos.manage`), byte-level type checking, size
 * limit, replacement cleanup, and the public media route the Register and
 * guest QR menu load them from.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { sniffImageType } = require('../../src/modules/pos/menu-images');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20, 3)]);

describe('POS menu item images', () => {
  const t = useTestApp();
  let ctx;
  let managerToken;
  let operatorToken;
  let storage;
  let menuItemId;

  function tokenFor(tenant, userId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const propertyId = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-menu-images-'));
    process.env.MENU_IMAGE_STORAGE_DIR = storage;
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'pos_operator');
    managerToken = tokenFor(ctx.a, ctx.a.users[0].id);
    operatorToken = tokenFor(ctx.a, ctx.a.users[1].id);
    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'IMG-BAR', name: 'Image Bar', type: 'bar' });
    [menuItemId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Chapman', category: 'Drinks', price: '15.00' });
  });

  afterAll(() => {
    delete process.env.MENU_IMAGE_STORAGE_DIR;
    fs.rmSync(storage, { recursive: true, force: true });
  });

  function upload(buffer, { token = managerToken, filename = 'photo.png', id = menuItemId } = {}) {
    return t.request.post(`/api/v1/pos/menu-items/${id}/image`).set('Authorization', `Bearer ${token}`).attach('image', buffer, filename);
  }

  it('recognises JPEG, PNG, and WebP by their bytes, and nothing else', () => {
    expect(sniffImageType(JPEG)).toBe('jpg');
    expect(sniffImageType(PNG)).toBe('png');
    expect(sniffImageType(WEBP)).toBe('webp');
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
  });

  it('uploads a photo, stores it under a random name, and serves it publicly with safe headers', async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    expect(res.body.data.image_path).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(res.body.data.image_url).toBe(`/api/v1/media/menu-items/${res.body.data.image_path}`);
    expect(fs.existsSync(path.join(storage, res.body.data.image_path))).toBe(true);

    // No Authorization header, no tenant Host — a guest's phone loading an <img>.
    const served = await t.request.get(res.body.data.image_url).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(served.body, PNG)).toBe(0);
  });

  it('includes image_url when listing menu items', async () => {
    const res = await t.request.get('/api/v1/pos/menu-items').set('Authorization', `Bearer ${managerToken}`);
    const item = res.body.data.find((row) => row.id === String(menuItemId));
    expect(item.image_url).toMatch(/^\/api\/v1\/media\/menu-items\/[0-9a-f-]{36}\.png$/);
  });

  it('replacing a photo deletes the old file', async () => {
    const first = await upload(JPEG, { filename: 'a.jpg' });
    const second = await upload(WEBP, { filename: 'b.webp' });
    expect(second.body.data.image_path).toMatch(/\.webp$/);
    // Deletion is best-effort and asynchronous.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(path.join(storage, first.body.data.image_path))).toBe(false);
    expect(fs.existsSync(path.join(storage, second.body.data.image_path))).toBe(true);
  });

  it('removes a photo', async () => {
    await upload(PNG);
    const res = await t.request.delete(`/api/v1/pos/menu-items/${menuItemId}/image`).set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.image_path).toBeNull();
    expect(res.body.data.image_url).toBeNull();
  });

  it('rejects a file that is not really an image, whatever it is named', async () => {
    const res = await upload(Buffer.from('<svg onload="alert(1)"></svg>'.padEnd(64, ' ')), { filename: 'evil.png' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_IMAGE');
  });

  it('rejects a photo over 2 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1)]);
    const res = await upload(big);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_IMAGE_TOO_LARGE');
  });

  it('rejects a request with no file', async () => {
    const res = await t.request.post(`/api/v1/pos/menu-items/${menuItemId}/image`).set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(400);
  });

  it('is manager-tier: a pos_operator cannot change photos', async () => {
    expect((await upload(PNG, { token: operatorToken })).status).toBe(403);
  });

  it("404s for another tenant's menu item", async () => {
    await setRole(ctx.b, 0, 'manager');
    const res = await upload(PNG, { token: tokenFor(ctx.b, ctx.b.users[0].id) });
    expect(res.status).toBe(404);
  });

  it('serves only well-formed random names — no traversal, no other files', async () => {
    fs.writeFileSync(path.join(storage, 'secret.txt'), 'nope');
    expect((await t.request.get('/api/v1/media/menu-items/secret.txt')).status).toBe(404);
    expect((await t.request.get('/api/v1/media/menu-items/..%2F..%2Fpackage.json')).status).toBe(404);
    expect((await t.request.get('/api/v1/media/menu-items/00000000-0000-0000-0000-000000000000.png')).status).toBe(404);
  });
});
