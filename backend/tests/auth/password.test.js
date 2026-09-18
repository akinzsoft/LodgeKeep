'use strict';

/**
 * Direct tests for `validatePassword`'s three branches — security-review
 * finding, `password.js`'s own header has the full reasoning: a real
 * breached-password check, a real byte-length guard against bcrypt's own
 * 72-BYTE silent truncation (not 72 characters — this file's own first
 * attempt at that fix measured `.length` instead of UTF-8 bytes, which is
 * wrong the moment a password contains any multi-byte character), and the
 * "code travels with the issue" fix so every rejection carries its own
 * specific error code rather than a hardcoded "too short."
 *
 * The multi-byte fixture below (`'😀'.repeat(20)`) is the actual point of
 * this file: 40 JS `.length` units (comfortably short by any character
 * count) but 80 UTF-8 bytes — exactly the string a character-counting
 * check would have silently accepted and bcrypt would have silently
 * truncated. `isPasswordBreached` is mocked here — the real, unmocked
 * network round trip lives in `tests/auth/breached-password.test.js`.
 */

jest.mock('../../src/auth/breached-password', () => ({ isPasswordBreached: jest.fn() }));

const { isPasswordBreached } = require('../../src/auth/breached-password');
const { validatePassword, MIN_LENGTH, MAX_BYTES } = require('../../src/auth/password');

describe('validatePassword', () => {
  beforeEach(() => {
    isPasswordBreached.mockReset().mockResolvedValue(false);
  });

  it('rejects a password shorter than MIN_LENGTH with the correct, specific code', async () => {
    const issue = await validatePassword('short');
    expect(issue).toEqual({ code: 'PASSWORD_TOO_SHORT', message: expect.stringContaining(String(MIN_LENGTH)) });
    expect(isPasswordBreached).not.toHaveBeenCalled();
  });

  it('accepts a password at exactly MAX_BYTES (72 ASCII bytes)', async () => {
    await expect(validatePassword('x'.repeat(MAX_BYTES))).resolves.toBeNull();
  });

  it('rejects a password one byte over MAX_BYTES (73 ASCII bytes) with the correct, specific code — not "too short"', async () => {
    const issue = await validatePassword('x'.repeat(MAX_BYTES + 1));
    expect(issue).toEqual({ code: 'PASSWORD_TOO_LONG', message: expect.stringContaining(String(MAX_BYTES)) });
  });

  it('rejects a password that passes a naive CHARACTER-length check but exceeds 72 UTF-8 bytes (multi-byte characters)', async () => {
    // 20 emoji: 40 UTF-16 code units (`.length`), comfortably under any
    // plausible character cap — but 80 UTF-8 bytes, already past bcrypt's
    // real 72-byte truncation point. Under the old, buggy `.length`-based
    // check this string was silently ACCEPTED and silently truncated by
    // bcrypt; the byte-based check must reject it.
    const multiByte = '😀'.repeat(20);
    expect(multiByte.length).toBe(40);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBe(80);
    const issue = await validatePassword(multiByte);
    expect(issue).toEqual({ code: 'PASSWORD_TOO_LONG', message: expect.any(String) });
  });

  it('accepts a password at exactly 72 UTF-8 bytes made of multi-byte characters', async () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes — 36 of them is exactly
    // 72 bytes. Proves the boundary is measured in bytes, not characters,
    // and that it's inclusive at exactly MAX_BYTES.
    const exactlyBoundary = 'é'.repeat(36);
    expect(Buffer.byteLength(exactlyBoundary, 'utf8')).toBe(72);
    await expect(validatePassword(exactlyBoundary)).resolves.toBeNull();
  });

  it('rejects a password one multi-byte character past the 72-byte boundary', async () => {
    const overBoundary = 'é'.repeat(37); // 74 bytes
    expect(Buffer.byteLength(overBoundary, 'utf8')).toBe(74);
    const issue = await validatePassword(overBoundary);
    expect(issue).toEqual({ code: 'PASSWORD_TOO_LONG', message: expect.any(String) });
  });

  it('rejects a breached password with the correct, specific code — not "too short"', async () => {
    isPasswordBreached.mockResolvedValue(true);
    const issue = await validatePassword('a genuinely long enough passphrase');
    expect(issue).toEqual({ code: 'PASSWORD_BREACHED', message: expect.any(String) });
  });

  it('accepts a password that passes every check', async () => {
    await expect(validatePassword('a genuinely long enough passphrase')).resolves.toBeNull();
  });
});
