'use strict';

const { generateVoucherCode, normalizeVoucherCode, formatVoucherCode, isPlausibleVoucherCode, VOUCHER_CODE_LENGTH, VOUCHER_ALPHABET } = require('../../src/shared/voucher-code');

describe('voucher codes', () => {
  it('generates 12 characters from the unambiguous alphabet, with no look-alikes', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateVoucherCode();
      expect(code).toHaveLength(VOUCHER_CODE_LENGTH);
      expect([...code].every((ch) => VOUCHER_ALPHABET.includes(ch))).toBe(true);
      expect(code).not.toMatch(/[01IO]/);
    }
  });

  it('has enough randomness: 5 bits a character, and thousands of codes never repeat', () => {
    expect(VOUCHER_ALPHABET).toHaveLength(32);
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(generateVoucherCode());
    expect(seen.size).toBe(5000);
  });

  it('every symbol of the alphabet turns up (no modulo bias towards the first ones)', () => {
    const counts = new Map();
    for (let i = 0; i < 4000; i += 1) for (const ch of generateVoucherCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    const values = [...counts.values()];
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.4);
  });

  it('normalises input: trim, upper case, strip spaces and dashes', () => {
    expect(normalizeVoucherCode('  abcd-efgh jklm \n')).toBe('ABCDEFGHJKLM');
    expect(normalizeVoucherCode('ab-cd--ef gh')).toBe('ABCDEFGH');
    expect(normalizeVoucherCode('ABCDEFGHJKLM')).toBe('ABCDEFGHJKLM');
  });

  it('shows a code in groups of four', () => {
    expect(formatVoucherCode('ABCDEFGHJKLM')).toBe('ABCD-EFGH-JKLM');
    expect(formatVoucherCode('abcd efgh')).toBe('ABCD-EFGH');
  });

  it('format then normalise is the identity', () => {
    const code = generateVoucherCode();
    expect(normalizeVoucherCode(formatVoucherCode(code))).toBe(code);
  });

  it.each([undefined, null, 12345678, {}, [], 'AB', 'A'.repeat(40), 'ABCD EFGH !', "ABCD'; DROP"])('%p is not a plausible code (no database lookup is made)', (value) => {
    expect(isPlausibleVoucherCode(normalizeVoucherCode(value))).toBe(false);
  });

  it('a normal code is plausible however it was typed', () => {
    expect(isPlausibleVoucherCode(normalizeVoucherCode('abcd-efgh-jkln'))).toBe(true);
  });
});
