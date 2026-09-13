'use strict';

/**
 * Property logos: upload/replace/remove through Setup (`setup.manage`),
 * served from the public media route, isolated per tenant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

describe('property logo', () => {
  const t = useTestApp();
  let ctx;
  let storage;
  let propertyId;

  function tokenFor(tenant, userId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const pid = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: pid }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: pid, user_id: userId, role });
  }

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-property-logos-'));
    process.env.PROPERTY_LOGO_STORAGE_DIR = storage;
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await setRole(ctx.a, 0, 'admin');
    await setRole(ctx.a, 1, 'manager');
  });

  afterAll(() => {
    delete process.env.PROPERTY_LOGO_STORAGE_DIR;
    fs.rmSync(storage, { recursive: true, force: true });
  });

  const adminToken = () => tokenFor(ctx.a, ctx.a.users[0].id);
  const upload = (buffer, token = adminToken(), id = propertyId, name = 'logo.png') =>
    t.request.post(`/api/v1/properties/${id}/logo`).set('Authorization', `Bearer ${token}`).attach('image', buffer, name);

  it('uploads a logo, stores its public URL on the property, and serves it', async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    expect(res.body.data.logo_url).toMatch(/^\/api\/v1\/media\/property-logos\/[0-9a-f-]{36}\.png$/);
    const served = await t.request.get(res.body.data.logo_url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');

    const listed = await t.request.get('/api/v1/properties').set('Authorization', `Bearer ${adminToken()}`);
    expect(listed.body.data.find((p) => p.id === String(propertyId)).logo_url).toBe(res.body.data.logo_url);
  });

  it('replacing the logo deletes the old file; removing clears it', async () => {
    const first = await upload(PNG);
    const second = await upload(JPEG, adminToken(), propertyId, 'logo.jpg');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const firstFile = first.body.data.logo_url.split('/').pop();
    const secondFile = second.body.data.logo_url.split('/').pop();
    expect(fs.existsSync(path.join(storage, firstFile))).toBe(false);
    expect(fs.existsSync(path.join(storage, secondFile))).toBe(true);

    const removed = await t.request.delete(`/api/v1/properties/${propertyId}/logo`).set('Authorization', `Bearer ${adminToken()}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.logo_url).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(path.join(storage, secondFile))).toBe(false);
  });

  it('never deletes a logo it did not upload (an external URL)', async () => {
    await t.trx('properties').where({ id: propertyId }).update({ logo_url: 'https://example.com/brand.png' });
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    expect(res.body.data.logo_url).toMatch(/^\/api\/v1\/media\/property-logos\//);
  });

  it('rejects a file that is not an image', async () => {
    const res = await upload(Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' ')));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_IMAGE');
  });

  it('requires setup.manage — a manager (view only) is refused', async () => {
    expect((await upload(PNG, tokenFor(ctx.a, ctx.a.users[1].id))).status).toBe(403);
  });

  it("404s for another tenant's property", async () => {
    const res = await upload(PNG, adminToken(), ctx.b.properties[0].id);
    expect(res.status).toBe(404);
  });
});
