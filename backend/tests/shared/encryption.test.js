'use strict';

/**
 * `src/shared/encryption.js` — the first encryption-at-rest utility in this
 * codebase, built for `email_settings.smtp_password_encrypted` (gap
 * closure: "add the mail setup on in SETUP menu"). Pure, no database — the
 * schema-level "is it genuinely encrypted, not plaintext" proof lives in
 * `tests/setup/email-settings.test.js` instead, against a real row.
 */

const crypto = require('crypto');

describe('encryption', () => {
  const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  afterEach(() => {
    jest.resetModules();
  });

  function freshModule() {
    return require('../../src/shared/encryption');
  }

  it('round-trips a real secret exactly', () => {
    const { encrypt, decrypt } = freshModule();
    const ciphertext = encrypt('correct horse battery staple');
    expect(decrypt(ciphertext)).toBe('correct horse battery staple');
  });

  it('never stores the plaintext anywhere in the ciphertext output', () => {
    const { encrypt } = freshModule();
    const ciphertext = encrypt('super-secret-password-123');
    expect(ciphertext).not.toContain('super-secret-password-123');
  });

  it('produces a different ciphertext for the same plaintext on each call (random IV)', () => {
    const { encrypt } = freshModule();
    const a = encrypt('same input');
    const b = encrypt('same input');
    expect(a).not.toBe(b);
  });

  it('rejects a tampered ciphertext rather than silently decrypting to garbage (GCM auth tag)', () => {
    const { encrypt, decrypt } = freshModule();
    const ciphertext = encrypt('a real secret');
    const [iv, tag, body] = ciphertext.split('.');
    const tamperedBody = Buffer.from(body, 'base64');
    tamperedBody[0] ^= 0xff;
    const tampered = [iv, tag, tamperedBody.toString('base64')].join('.');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws a clear error when ENCRYPTION_KEY is not set, rather than a cryptic crypto error', () => {
    delete process.env.ENCRYPTION_KEY;
    const { encrypt } = freshModule();
    expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
  });

  it('throws a clear error when ENCRYPTION_KEY does not decode to 32 bytes', () => {
    process.env.ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    const { encrypt } = freshModule();
    expect(() => encrypt('x')).toThrow(/32 bytes/);
  });
});
