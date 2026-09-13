'use strict';

/**
 * Branded emails: every templated email is wrapped in the property's shell
 * (logo or name header, card, name/address footer), variables are escaped
 * and dates read naturally, and an uploaded property logo travels as an
 * inline `cid:` attachment.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { workerContext } = require('../../src/modules/tenancy');
const { scopedDb } = require('../../src/db');
const { composeEmail } = require('../../src/modules/notifications/service');
const { htmlToText } = require('../../src/modules/notifications/email-adapter');

describe('branded emails', () => {
  const t = useTestApp();
  let ctx;
  let storage;
  let db;
  let propertyId;

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-logos-'));
    process.env.PROPERTY_LOGO_STORAGE_DIR = storage;
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ name: 'Harbour View Hotel', address: '12 Marina Road, Lagos' });
    db = scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId }));
  });

  afterAll(() => {
    delete process.env.PROPERTY_LOGO_STORAGE_DIR;
    fs.rmSync(storage, { recursive: true, force: true });
  });

  const booking = {
    guestName: 'Ada <b>Bello</b>',
    confirmationNumber: 'LK12345',
    arrivalDate: '2027-03-01',
    departureDate: '2027-03-04',
  };

  // `checked_in` has no fixture-seeded property override, so the built-in default renders.
  it('wraps the message in the property shell with its name and address, escaping variables and formatting dates', async () => {
    const email = await composeEmail({ db, propertyId, templateKey: 'checked_in', variables: { ...booking, roomNumber: '205' } });

    expect(email.subject).toBe('Welcome to Harbour View Hotel');
    expect(email.html).toMatch(/^<!DOCTYPE html>/);
    expect(email.html).toContain('Welcome to Harbour View Hotel');
    expect(email.html).toContain('12 Marina Road, Lagos');
    expect(email.html).toContain('Ada &lt;b&gt;Bello&lt;/b&gt;');
    expect(email.html).not.toContain('<b>Bello</b>');
    expect(email.html).toContain('Thu, 4 Mar 2027');
    expect(email.html).toContain('205');
    expect(email.html).not.toMatch(/\{\{\w+\}\}/);
    // No uploaded logo: the property name is the header, nothing attached.
    expect(email.attachments).toEqual([]);
    expect(email.html).not.toContain('cid:');
  });

  it('attaches an uploaded logo inline and shows it in the header', async () => {
    const fileName = '0f1e2d3c-4b5a-4968-8776-655443322110.png';
    // A real 600×200 PNG — shown at exactly 216×72 (the header's 240×72 box), never stretched.
    fs.writeFileSync(path.join(storage, fileName), Buffer.from(require('../shared/fixtures/sample-images.json').png, 'base64'));
    await t.trx('properties').where({ id: propertyId }).update({ logo_url: `/api/v1/media/property-logos/${fileName}` });

    const email = await composeEmail({ db, propertyId, templateKey: 'checked_out', variables: { ...booking, folioBalance: '0.00' } });
    expect(email.attachments).toEqual([expect.objectContaining({ cid: 'property-logo', filename: 'logo.png', contentType: 'image/png', path: path.join(storage, fileName) })]);
    expect(email.html).toContain('src="cid:property-logo"');
    expect(email.html).toContain('alt="Harbour View Hotel"');
    expect(email.html).toContain('width="216" height="72"');

    await t.trx('properties').where({ id: propertyId }).update({ logo_url: null });
  });

  it('ignores a logo URL that is not one of our uploads, falling back to the name', async () => {
    await t.trx('properties').where({ id: propertyId }).update({ logo_url: 'https://example.com/logo.png' });
    const email = await composeEmail({ db, propertyId, templateKey: 'staff_mfa_code', variables: { code: '482913', expiresInMinutes: 10 } });
    expect(email.attachments).toEqual([]);
    expect(email.html).toContain('482913');
    await t.trx('properties').where({ id: propertyId }).update({ logo_url: null });
  });

  it('gives every built-in template a branded, fully substituted body', async () => {
    const { EVENT_TEMPLATE_KEYS } = require('../../src/modules/notifications/service');
    const variables = {
      ...booking,
      roomNumber: '205',
      folioBalance: '0.00',
      role: 'front_desk',
      invitationUrl: 'https://example.com/invite?token=a&b=c',
      resetUrl: 'https://example.com/reset',
      expiresInHours: 1,
      code: '123456',
      expiresInMinutes: 10,
      companyName: 'Acme Ltd',
      invoiceNumber: 'INV-1',
      totalAmount: '500.00',
      currency: 'NGN',
      dueAt: '2027-04-01',
      amount: '500.00',
      urgencyLabel: 'Final warning',
      message: 'Payment failed.',
      nextRetryDate: '2027-04-05',
      tenantName: 'Alpha Hotels',
      attemptCount: 5,
    };
    for (const templateKey of new Set(Object.values(EVENT_TEMPLATE_KEYS))) {
      // Skip the fixture-seeded property override for reservation_confirmed.
      if (templateKey === 'reservation_confirmed') continue;
      const email = await composeEmail({ db, propertyId, templateKey, variables });
      expect(email.subject).not.toMatch(/\{\{/);
      expect(email.html).not.toMatch(/\{\{\w+\}\}/);
      expect(email.html).toContain('Powered by LodgeKeep');
    }
  });

  it('turns the branded HTML into readable plain text without the head or hidden preview line', async () => {
    const email = await composeEmail({ db, propertyId, templateKey: 'guest_password_reset', variables: { resetUrl: 'https://example.com/reset', expiresInHours: 1 } });
    const text = htmlToText(email.html);
    expect(text).toContain('Reset your password (https://example.com/reset)');
    expect(text).not.toContain('<');
    expect(text).not.toContain('<title>');
    expect(text.startsWith('Harbour View Hotel')).toBe(true);
  });
});
