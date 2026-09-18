'use strict';

/**
 * `validateStartupConfig` — security-review finding, see
 * `src/shared/startup-checks.js`'s own header. Both `auth/tokens.js`'s
 * `secret()` and `shared/encryption.js`'s `loadKey()` read `process.env`
 * fresh on every call (never cached at require time), so these tests
 * mutate `process.env` directly per case and restore it afterward — no
 * module cache reset needed.
 */

const { validateStartupConfig } = require('../../src/shared/startup-checks');

describe('validateStartupConfig', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  afterEach(() => {
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it('passes silently when both secrets are real and correctly shaped', () => {
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('refuses to start when JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    expect(() => validateStartupConfig()).toThrow(/JWT_SECRET/);
  });

  it('refuses to start when JWT_SECRET is an empty string', () => {
    process.env.JWT_SECRET = '';
    expect(() => validateStartupConfig()).toThrow(/JWT_SECRET/);
  });

  it('refuses to start when ENCRYPTION_KEY is unset', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => validateStartupConfig()).toThrow(/ENCRYPTION_KEY/);
  });

  it('refuses to start when ENCRYPTION_KEY does not decode to exactly 32 bytes', () => {
    process.env.ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    expect(() => validateStartupConfig()).toThrow(/ENCRYPTION_KEY/);
  });

  it('reports BOTH problems at once when both secrets are broken, not just the first', () => {
    delete process.env.JWT_SECRET;
    delete process.env.ENCRYPTION_KEY;
    try {
      validateStartupConfig();
      throw new Error('expected validateStartupConfig to throw');
    } catch (error) {
      expect(error.message).toMatch(/JWT_SECRET/);
      expect(error.message).toMatch(/ENCRYPTION_KEY/);
    }
  });
});
