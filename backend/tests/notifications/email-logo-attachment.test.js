'use strict';

/**
 * Production bug: every e-mail for a property WITH a logo failed with "File access rejected for /app/storage/property-logos/<uuid>.webp",
 * because the logo was attached by file `path` while the SMTP transports run with nodemailer's `disableFileAccess: true`. Tenants
 * without a logo were fine. The logo now travels as in-memory `content`; a missing or invalid logo means no logo, never a failed mail.
 *
 * These tests send the REAL composed e-mail through a nodemailer transport with the same file/URL-access switches the production
 * SMTP transport uses, so putting `path` back fails here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { workerContext } = require('../../src/modules/tenancy');
const { scopedDb } = require('../../src/db');
const { composeEmail } = require('../../src/modules/notifications/service');
const imageStore = require('../../src/shared/image-store');

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function productionLikeTransport() {
  // The same switches as `buildTransport` in email-adapter.js; the stream transport only captures the message.
  return nodemailer.createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true });
}

describe('e-mail logo attachment', () => {
  const t = useTestApp();
  let ctx;
  let storage;
  let db;
  let propertyId;

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-logo-attach-'));
    process.env.PROPERTY_LOGO_STORAGE_DIR = storage;
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    db = scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId }));
  });

  afterAll(() => {
    delete process.env.PROPERTY_LOGO_STORAGE_DIR;
    fs.rmSync(storage, { recursive: true, force: true });
  });

  async function composeWithLogoUrl(logoUrl) {
    await t.trx('properties').where({ id: propertyId }).update({ logo_url: logoUrl });
    return composeEmail({ db, propertyId, templateKey: 'staff_mfa_code', variables: { code: '123456', expiresInMinutes: 10 } });
  }

  const send = (email) => productionLikeTransport().sendMail({ from: 'LodgeKeep <no-reply@example.com>', to: 'user@example.com', subject: email.subject, html: email.html, attachments: email.attachments });

  it('a property WITH a logo sends (the login code e-mail) through a transport with file access disabled, logo inline', async () => {
    const fileName = imageStore.saveImage('property-logos', PNG);
    const email = await composeWithLogoUrl(imageStore.imageUrl('property-logos', fileName));

    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ cid: 'property-logo', contentDisposition: 'inline', contentType: 'image/png' });
    expect(Buffer.isBuffer(email.attachments[0].content)).toBe(true);
    expect(email.attachments[0]).not.toHaveProperty('path');

    const info = await send(email);
    const raw = info.message.toString();
    expect(raw).toContain('Content-ID: <property-logo>');
    expect(raw).toContain('image/png');
    expect(email.html).toContain('cid:property-logo');
  });

  it('proves the regression: a `path` attachment is rejected by the same transport', async () => {
    const fileName = imageStore.saveImage('property-logos', PNG);
    const filePath = imageStore.imageFilePath('property-logos', fileName);
    await expect(
      productionLikeTransport().sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 's', html: '<p>x</p>', attachments: [{ filename: 'logo.png', path: filePath, cid: 'property-logo' }] })
    ).rejects.toThrow(/File access rejected/);
  });

  it('a logo URL whose file is missing still sends, without a logo', async () => {
    const email = await composeWithLogoUrl(imageStore.imageUrl('property-logos', `${crypto.randomUUID()}.png`));
    expect(email.attachments).toEqual([]);
    expect(email.html).not.toContain('cid:property-logo');
    await expect(send(email)).resolves.toBeTruthy();
  });

  it('an unreadable, corrupt, mismatched or oversized logo still sends, without a logo', async () => {
    const cases = {
      corrupt: Buffer.from('this is not an image at all, just text'),
      mismatched: PNG, // stored under a .webp name below
      oversized: Buffer.concat([PNG, Buffer.alloc(imageStore.MAX_IMAGE_BYTES + 1)]),
    };
    for (const [label, bytes] of Object.entries(cases)) {
      const fileName = `${crypto.randomUUID()}.${label === 'mismatched' ? 'webp' : 'png'}`;
      fs.writeFileSync(path.join(storage, fileName), bytes);
      const email = await composeWithLogoUrl(imageStore.imageUrl('property-logos', fileName));
      expect({ label, attachments: email.attachments }).toEqual({ label, attachments: [] });
      await expect(send(email)).resolves.toBeTruthy();
    }
  });

  it('a file that exists but cannot be read still sends, without a logo', async () => {
    const fileName = imageStore.saveImage('property-logos', PNG);
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
    try {
      const email = await composeWithLogoUrl(imageStore.imageUrl('property-logos', fileName));
      expect(email.attachments).toEqual([]);
      await expect(send(email)).resolves.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('a property with no logo at all sends, and an external logo URL is never fetched or attached', async () => {
    for (const logoUrl of [null, 'https://evil.example.com/logo.png', '/etc/passwd', '../../etc/passwd']) {
      const email = await composeWithLogoUrl(logoUrl);
      expect(email.attachments).toEqual([]);
      await expect(send(email)).resolves.toBeTruthy();
    }
  });

  it('the production SMTP transport keeps file and URL access disabled', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/modules/notifications/email-adapter.js'), 'utf8');
    expect(source).toMatch(/disableFileAccess:\s*true/);
    expect(source).toMatch(/disableUrlAccess:\s*true/);
  });

  it('no e-mail attachment anywhere in src is built from a file path', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /filename:[^\n]*\bpath:/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    walk(path.join(__dirname, '../../src'));
    expect(offenders).toEqual([]);
  });
});

describe('e-mail logo attachment survives a transport switch', () => {
  jest.setTimeout(30000);
  const t = useTestApp();

  it('the same composed e-mail reaches sendMail identically over the old and a new SMTP host', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-logo-switch-'));
    process.env.PROPERTY_LOGO_STORAGE_DIR = storage;
    const originalEnv = { ...process.env };
    const adapterModule = require('../../src/modules/notifications/email-adapter');
    const createTransport = jest.spyOn(nodemailer, 'createTransport');
    try {
      const ctx = await seedTwoTenants(t.trx);
      const propertyId = ctx.a.properties[0].id;
      const db = scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId }));
      const fileName = imageStore.saveImage('property-logos', PNG);
      await t.trx('properties').where({ id: propertyId }).update({ logo_url: imageStore.imageUrl('property-logos', fileName) });
      const email = await composeEmail({ db, propertyId, templateKey: 'staff_mfa_code', variables: { code: '123456', expiresInMinutes: 10 } });
      expect(email.attachments).toHaveLength(1);

      const sentAttachments = [];
      for (const env of [
        { SMTP_HOST: 'mail.old-host.example', SMTP_PORT: '587', SMTP_USER: 'box@planmsys.com', SMTP_PASSWORD: 'x' },
        { SMTP_HOST: 'smtp.provider.example', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'apikey', SMTP_PASS: 'y', MAIL_FROM_ADDRESS: 'lodgekeep@planmsys.com' },
      ]) {
        adapterModule.__closeSmtpTransportForTesting();
        for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PASSWORD', 'MAIL_FROM_ADDRESS']) delete process.env[key];
        Object.assign(process.env, env);
        const sendMail = jest.fn().mockResolvedValue({ messageId: '<id>' });
        createTransport.mockReturnValueOnce({ sendMail, close: jest.fn() });
        await adapterModule.smtpAdapter.send({ to: 'u@example.com', subject: email.subject, html: email.html, attachments: email.attachments });
        const options = createTransport.mock.calls.at(-1)[0];
        // Whatever the host, the transport still refuses file and URL access, and the logo is in-memory content.
        expect(options).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
        const [attachment] = sendMail.mock.calls[0][0].attachments;
        expect(attachment).toMatchObject({ cid: 'property-logo', contentDisposition: 'inline', contentType: 'image/png' });
        expect(Buffer.isBuffer(attachment.content)).toBe(true);
        expect(attachment).not.toHaveProperty('path');
        sentAttachments.push(attachment.content.toString('base64'));
      }
      expect(sentAttachments[0]).toBe(sentAttachments[1]);
    } finally {
      createTransport.mockRestore();
      adapterModule.__closeSmtpTransportForTesting();
      process.env = originalEnv;
      delete process.env.PROPERTY_LOGO_STORAGE_DIR;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
});
