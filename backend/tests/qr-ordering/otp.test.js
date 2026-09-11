'use strict';

const { generateOtpCode, hashOtpCode } = require('../../src/modules/qr-ordering/otp');

describe('qr-ordering otp (PLAN.md Phase 6)', () => {
  it('generates a real 6-digit numeric code, zero-padded', () => {
    for (let i = 0; i < 20; i += 1) {
      const { code } = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('hashes consistently and matches the code returned alongside it', () => {
    const { code, hash } = generateOtpCode();
    expect(hashOtpCode(code)).toBe(hash);
    expect(hashOtpCode(code)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces a different hash for a different code', () => {
    expect(hashOtpCode('000000')).not.toBe(hashOtpCode('111111'));
  });
});
