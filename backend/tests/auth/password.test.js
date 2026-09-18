'use strict';

/**
 * Direct tests for `validatePassword`'s three branches — security-review
 * finding, `password.js`'s own header has the full reasoning (a real
 * breached-password check, a real max-length guard against bcrypt's own
 * 72-byte silent truncation, and the bug this pass found alongside them:
 * every call site used to hardcode `'PASSWORD_TOO_SHORT'` regardless of
 * which check actually failed). `isPasswordBreached` is mocked here —
 * the real, unmocked network round trip lives in
 * `tests/auth/breached-password.test.js`.
 */

jest.mock('../../src/auth/breached-password', () => ({ isPasswordBreached: jest.fn() }));

const { isPasswordBreached } = require('../../src/auth/breached-password');
const { validatePassword, MIN_LENGTH, MAX_LENGTH } = require('../../src/auth/password');

describe('validatePassword', () => {
  beforeEach(() => {
    isPasswordBreached.mockReset().mockResolvedValue(false);
  });

  it('rejects a password shorter than MIN_LENGTH with the correct, specific code', async () => {
    const issue = await validatePassword('short');
    expect(issue).toEqual({ code: 'PASSWORD_TOO_SHORT', message: expect.stringContaining(String(MIN_LENGTH)) });
    expect(isPasswordBreached).not.toHaveBeenCalled();
  });

  it('rejects a password longer than MAX_LENGTH with the correct, specific code — not the "too short" one', async () => {
    const issue = await validatePassword('x'.repeat(MAX_LENGTH + 1));
    expect(issue).toEqual({ code: 'PASSWORD_TOO_LONG', message: expect.stringContaining(String(MAX_LENGTH)) });
  });

  it('accepts a password at exactly MAX_LENGTH', async () => {
    await expect(validatePassword('x'.repeat(MAX_LENGTH))).resolves.toBeNull();
  });

  it('rejects a breached password with the correct, specific code — not the "too short" one', async () => {
    isPasswordBreached.mockResolvedValue(true);
    const issue = await validatePassword('a genuinely long enough passphrase');
    expect(issue).toEqual({ code: 'PASSWORD_BREACHED', message: expect.any(String) });
  });

  it('accepts a password that passes every check', async () => {
    await expect(validatePassword('a genuinely long enough passphrase')).resolves.toBeNull();
  });
});
