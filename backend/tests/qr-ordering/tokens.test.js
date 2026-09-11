'use strict';

/**
 * Pure tests for `src/modules/qr-ordering/tokens.js` — PLAN.md Phase 6. The
 * security-critical path this session explicitly asked to mutation-test
 * hardest: a token's raw value round-trips through real encryption
 * exactly once, its hash is stable and lookup-safe, and a tampered
 * ciphertext is rejected outright via the GCM auth tag — the same
 * discipline `tests/setup/email-settings.test.js` already established for
 * `smtp_password_encrypted`.
 */

const { generateRawToken, hashToken, encryptToken, decryptToken, renderTokenQrImage } = require('../../src/modules/qr-ordering/tokens');

describe('qr-ordering tokens (PLAN.md Phase 6)', () => {
  it('generates a real, sufficiently random raw token', () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(30);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes the same raw token to the same hash, and different tokens to different hashes', () => {
    const raw = generateRawToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
    expect(hashToken(raw)).not.toBe(hashToken(generateRawToken()));
    expect(hashToken(raw)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('encrypts then decrypts back to the exact original raw token', () => {
    const raw = generateRawToken();
    const encrypted = encryptToken(raw);
    expect(encrypted).not.toContain(raw);
    expect(decryptToken(encrypted)).toBe(raw);
  });

  it('produces a different ciphertext for the same raw token on two separate calls (random IV per call)', () => {
    const raw = generateRawToken();
    const first = encryptToken(raw);
    const second = encryptToken(raw);
    expect(first).not.toBe(second);
    expect(decryptToken(first)).toBe(raw);
    expect(decryptToken(second)).toBe(raw);
  });

  it('rejects a tampered ciphertext via the GCM auth tag rather than silently decrypting garbage', () => {
    const raw = generateRawToken();
    const encrypted = encryptToken(raw);
    const [iv, tag, ciphertext] = encrypted.split('.');
    const tamperedByte = Buffer.from(ciphertext, 'base64');
    tamperedByte[0] ^= 0xff;
    const tampered = [iv, tag, tamperedByte.toString('base64')].join('.');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('renders a real scannable data-URL QR image encoding the guest-ordering URL for the raw token', async () => {
    const raw = generateRawToken();
    const dataUrl = await renderTokenQrImage(raw, { baseUrl: 'https://alpha-hotels.example.com/qr-order' });
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
