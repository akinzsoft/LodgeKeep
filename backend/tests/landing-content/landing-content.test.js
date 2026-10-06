'use strict';

/**
 * The platform console edits the marketing landing page; the public page reads it.
 *
 *   - the allow-list: only the agreed fields, each validated; anything else is rejected;
 *   - the monthly fee and trial length are NOT editable and come live from the
 *     billing plan and the trial setting, so the page cannot quote what customers
 *     are not charged;
 *   - admin-only writes, both tiers read, append-only history with reset/restore;
 *   - the public read needs no login and no tenant and exposes no tenant data.
 */

const { useTestApp } = require('../helpers/app');
const { seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { validateContent } = require('../../src/modules/landing-content/fields');
const { DEFAULT_TRIAL_PERIOD_DAYS } = require('../../src/shared/tenant-lifecycle');

describe('validateContent', () => {
  const issuesOf = (input) => {
    try {
      validateContent(input);
      return [];
    } catch (error) {
      return error.details.map((d) => d.field);
    }
  };

  test('accepts the agreed fields and cleans them', () => {
    const clean = validateContent({
      hero: { headline: '  Run it all  ' },
      pricing: { setupAmount: '500000', includes: ['One', 'Two'] },
      contact: { whatsapp: '+234 703 130 8712', email: 'info@planmsys.com', phone: '' },
      video: { src: '/lodgekeep-demo.mp4' },
      testimonials: { items: [{ quote: 'Great.', name: 'Ada', role: 'Owner' }] },
    });
    expect(clean.hero.headline).toBe('Run it all');
    expect(clean.pricing.setupAmount).toBe('500000.00');
    expect(clean.contact).toEqual({ whatsapp: '2347031308712', email: 'info@planmsys.com', phone: '' });
  });

  test('rejects anything outside the allow-list, including the monthly fee and trial length', () => {
    expect(issuesOf({ pricing: { amount: '10.00' } })).toEqual(['pricing.amount']);
    expect(issuesOf({ pricing: { trial: '90 days' } })).toEqual(['pricing.trial']);
    expect(issuesOf({ footer: { blurb: 'x' } })).toEqual(['footer']);
    expect(issuesOf({ hero: { image: 'x' } })).toEqual(['hero.image']);
    expect(issuesOf([])).toEqual(['content']);
    expect(issuesOf({ hero: 'x' })).toEqual(['hero']);
  });

  test('rejects bad values with the field named', () => {
    expect(issuesOf({ hero: { headline: '' } })).toEqual(['hero.headline']);
    expect(issuesOf({ hero: { headline: 'x'.repeat(121) } })).toEqual(['hero.headline']);
    expect(issuesOf({ contact: { whatsapp: '12345' } })).toEqual(['contact.whatsapp']);
    expect(issuesOf({ contact: { whatsapp: 'call me' } })).toEqual(['contact.whatsapp']);
    expect(issuesOf({ contact: { email: 'nope' } })).toEqual(['contact.email']);
    // Becomes a mailto: link, so characters that could add mail headers are refused.
    for (const bad of ['a@b.co?bcc=x@y.com', 'a@b.co&cc=x@y.com', 'a@b.co,x@y.com']) expect(issuesOf({ contact: { email: bad } })).toEqual(['contact.email']);
    expect(issuesOf({ pricing: { setupAmount: '-5' } })).toEqual(['pricing.setupAmount']);
    expect(issuesOf({ pricing: { setupAmount: '1.234' } })).toEqual(['pricing.setupAmount']);
    expect(issuesOf({ pricing: { includes: [] } })).toEqual(['pricing.includes']);
    expect(issuesOf({ pricing: { includes: ['ok', ''] } })).toEqual(['pricing.includes[1]']);
    expect(issuesOf({ testimonials: { items: [{ quote: 'q', name: '' }] } })).toEqual(['testimonials.items[0].name']);
    expect(issuesOf({ testimonials: { items: Array(7).fill({ quote: 'q', name: 'n' }) } })).toEqual(['testimonials.items']);
  });

  test('a video or poster must be a file this site hosts, never another site or a script', () => {
    for (const bad of ['https://evil.example/x.mp4', '//evil.example/x.mp4', '/../etc/x.mp4', '/x.js', 'x.mp4', 'javascript:alert(1)', '/a b.mp4']) {
      expect(issuesOf({ video: { src: bad } })).toEqual(['video.src']);
    }
    expect(issuesOf({ video: { src: '/demo/v1.webm', poster: '/poster.webp' } })).toEqual([]);
  });

  test('empty contact channels are allowed (they hide the button)', () => {
    expect(validateContent({ contact: { whatsapp: '', phone: '', email: '' } }).contact).toEqual({ whatsapp: '', phone: '', email: '' });
  });
});

describe('landing content over HTTP', () => {
  const t = useTestApp();
  let admin;
  let support;
  const token = (user) => signAccessToken({ aud: 'platform', sub: String(user.id) });
  const asUser = (user) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${token(user)}`),
    put: (url, body) => t.request.put(url).set('Authorization', `Bearer ${token(user)}`).send(body),
    post: (url, body) => t.request.post(url).set('Authorization', `Bearer ${token(user)}`).send(body ?? {}),
  });
  const publicRead = () => t.request.get('/api/v1/public/landing-content');

  beforeAll(async () => {
    admin = await seedPlatformUser(t.trx, 'landing-admin@planmsys.test', 'admin');
    support = await seedPlatformUser(t.trx, 'landing-support@planmsys.test', 'support');
  });

  test('with nothing saved, the public read has empty overrides and the LIVE plan price and trial length', async () => {
    const plan = await t.trx('plans').where({ is_active: true }).orderBy('id').first();
    const res = await publicRead();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body.data).toEqual({
      overrides: {},
      monthly: { amount: plan.price, currency: plan.currency, interval: plan.billing_interval },
      trialDays: DEFAULT_TRIAL_PERIOD_DAYS,
      updatedAt: null,
    });
  });

  test('the public monthly fee follows the billing plan, so the page cannot drift from what is charged', async () => {
    const plan = await t.trx('plans').where({ is_active: true }).orderBy('id').first();
    await t.trx('plans').where({ id: plan.id }).update({ price: '41000.00' });
    expect((await publicRead()).body.data.monthly.amount).toBe('41000.00');
  });

  test('an admin saves; the public page sees it at once; the history records who and when', async () => {
    const saved = await asUser(admin).put('/api/v1/platform/landing-content', {
      content: { contact: { whatsapp: '2347031308712', email: 'info@planmsys.com' }, pricing: { setupAmount: '500000' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ note: 'Saved', created_by_platform_user_id: String(admin.id) });

    const pub = (await publicRead()).body.data;
    expect(pub.overrides).toEqual({ contact: { whatsapp: '2347031308712', email: 'info@planmsys.com' }, pricing: { setupAmount: '500000.00' } });
    expect(pub.updatedAt).not.toBeNull();
  });

  test('the public read exposes only the marketing payload: no tenant, user or platform data', async () => {
    const data = (await publicRead()).body.data;
    expect(Object.keys(data).sort()).toEqual(['monthly', 'overrides', 'trialDays', 'updatedAt']);
    expect(JSON.stringify(data)).not.toMatch(/tenant|user|email_verified|password|platform/i);
    // It needs neither a login nor a tenant host.
    expect((await t.request.get('/api/v1/public/landing-content').set('Host', 'some-tenant.localhost')).status).toBe(200);
  });

  test('a save with any invalid field is refused as a whole and nothing is written', async () => {
    const before = await t.trx('landing_content_versions').count({ n: '*' }).first();
    const res = await asUser(admin).put('/api/v1/platform/landing-content', {
      content: { hero: { headline: 'fine' }, contact: { email: 'not-an-email' }, pricing: { amount: '1.00' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_CONTENT');
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['contact.email', 'pricing.amount']);
    expect((await t.trx('landing_content_versions').count({ n: '*' }).first()).n).toBe(before.n);
  });

  test('support-tier staff can read the console view but cannot save, reset or restore', async () => {
    const view = await asUser(support).get('/api/v1/platform/landing-content');
    expect(view.status).toBe(200);
    expect(view.body.data.current.content.contact.whatsapp).toBe('2347031308712');
    expect(view.body.data.monthly).toBeTruthy();
    expect(view.body.data.trialDays).toBe(DEFAULT_TRIAL_PERIOD_DAYS);

    const before = await t.trx('landing_content_versions').count({ n: '*' }).first();
    expect((await asUser(support).put('/api/v1/platform/landing-content', { content: {} })).status).toBe(403);
    expect((await asUser(support).post('/api/v1/platform/landing-content/reset')).status).toBe(403);
    expect((await asUser(support).post(`/api/v1/platform/landing-content/versions/${view.body.data.current.id}/restore`)).status).toBe(403);
    expect((await t.trx('landing_content_versions').count({ n: '*' }).first()).n).toBe(before.n);
  });

  test('no token, or a staff/guest token, cannot reach the console routes', async () => {
    expect((await t.request.get('/api/v1/platform/landing-content')).status).toBe(401);
    const staff = signAccessToken({ aud: 'staff', sub: '1', tenantId: '1' });
    const wrong = await t.request.get('/api/v1/platform/landing-content').set('Authorization', `Bearer ${staff}`);
    expect(wrong.status).toBe(401);
  });

  test('reset to defaults adds an empty version; restore brings an older one back; history is append-only', async () => {
    const firstView = (await asUser(admin).get('/api/v1/platform/landing-content')).body.data;
    const savedId = firstView.current.id;

    const reset = await asUser(admin).post('/api/v1/platform/landing-content/reset');
    expect(reset.body.data).toMatchObject({ note: 'Reset to defaults', content: {} });
    expect((await publicRead()).body.data.overrides).toEqual({});

    const restored = await asUser(admin).post(`/api/v1/platform/landing-content/versions/${savedId}/restore`);
    expect(restored.body.data.note).toBe(`Restored version ${savedId}`);
    expect((await publicRead()).body.data.overrides.contact.whatsapp).toBe('2347031308712');

    const view = (await asUser(admin).get('/api/v1/platform/landing-content')).body.data;
    expect(view.versions.length).toBeGreaterThanOrEqual(3);
    expect(view.versions[0].id).toBe(restored.body.data.id);
    // Older rows are untouched.
    expect(view.versions.find((v) => v.id === savedId).note).toBe('Saved');
  });

  test('restoring re-validates the old content against today\'s allow-list', async () => {
    const [id] = await t.trx('landing_content_versions').insert({
      content_json: JSON.stringify({ pricing: { amount: '1.00' } }),
      note: 'Saved under an older allow-list',
      created_by_platform_user_id: admin.id,
    });
    const before = await t.trx('landing_content_versions').count({ n: '*' }).first();
    const res = await asUser(admin).post(`/api/v1/platform/landing-content/versions/${id}/restore`);
    expect(res.status).toBe(400);
    expect((await t.trx('landing_content_versions').count({ n: '*' }).first()).n).toBe(before.n);
  });

  test('restoring a version that does not exist is a 404', async () => {
    expect((await asUser(admin).post('/api/v1/platform/landing-content/versions/999999999/restore')).status).toBe(404);
  });
});

describe('the backend allow-list and the frontend field list stay in step', () => {
  const fs = require('fs');
  const path = require('path');
  const { SCHEMA } = require('../../src/modules/landing-content/fields');

  // The frontend list drives the console form and applyOverrides; the backend list is the authority
  // on what may be saved. A field added to only one side would quietly not work, so this pins them.
  const source = fs.readFileSync(path.join(__dirname, '../../../frontend/src/landing/contentOverrides.js'), 'utf8');
  const frontend = [...source.matchAll(/\{ section: '(\w+)', field: '(\w+)', kind: '(\w+)' \}/g)].map(([, section, field, kind]) => ({ section, field, kind }));
  const KIND = { text: 'text', money: 'optional', digits: 'optional', email: 'optional', media: 'optional', list: 'list', testimonials: 'items' };
  const backend = Object.entries(SCHEMA).flatMap(([section, fields]) => Object.entries(fields).map(([field, rule]) => ({ section, field, kind: KIND[rule.kind] })));
  const key = (e) => `${e.section}.${e.field}:${e.kind}`;

  test('the same fields, with compatible kinds, on both sides', () => {
    expect(frontend.length).toBeGreaterThan(10);
    expect(frontend.map(key).sort()).toEqual(backend.map(key).sort());
  });
});
