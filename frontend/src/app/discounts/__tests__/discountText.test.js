import { describe, it, expect } from 'vitest';
import { describeRule, receiptDiscountLabel } from '../discountText.js';

describe('voucher wording', () => {
  it('a voucher rule names its code and its worth', () => {
    expect(describeRule({ kind: 'voucher', type: 'percent', value: '10.00', voucher_code: 'ABCD-EFGH-JKLM' }, (a) => a)).toBe('Voucher ABCD-EFGH-JKLM · 10%');
    expect(describeRule({ kind: 'voucher', type: 'fixed', value: '500.00', voucher_code: 'ABCD-EFGH-JKLM' }, (a) => `${a} NGN`)).toBe('Voucher ABCD-EFGH-JKLM · 500.00 NGN');
  });

  it('a receipt line names a voucher by its code and keeps the old wording for the rest', () => {
    expect(receiptDiscountLabel({ kind: 'voucher', voucherCode: 'ABCD-EFGH-JKLM', reason: 'Voucher' })).toBe('Voucher ABCD-EFGH-JKLM');
    expect(receiptDiscountLabel({ kind: 'voucher', voucher_code: 'ABCD-EFGH-JKLM' })).toBe('Voucher ABCD-EFGH-JKLM');
    expect(receiptDiscountLabel({ kind: 'voucher' })).toBe('Voucher');
    expect(receiptDiscountLabel({ kind: 'comp', reason: 'Staff meal' })).toBe('Comp · Staff meal');
    expect(receiptDiscountLabel({ kind: 'discount', reason: 'Promotion' })).toBe('Discount · Promotion');
  });
});
