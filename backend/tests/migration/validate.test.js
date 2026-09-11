'use strict';

/**
 * Per-entity-type row validation — PRODUCT_REQUIREMENTS.md §3.20's own
 * named cases ("missing required fields, invalid dates, unknown room
 * types, departure before arrival"), pure, no database.
 */

const { validateGuestRow, validateCompanyRow, validateReservationRow, validateArBalanceRow } = require('../../src/modules/migration/validate');

describe('validateGuestRow', () => {
  it('accepts a clean row', () => {
    expect(validateGuestRow({ first_name: 'Ada', last_name: 'Okafor', email: 'ada@example.com' })).toEqual([]);
  });

  it('requires first_name and last_name', () => {
    const errors = validateGuestRow({ email: 'ada@example.com' });
    expect(errors.map((e) => e.columnName)).toEqual(expect.arrayContaining(['first_name', 'last_name']));
  });

  it('requires at least one of email or phone', () => {
    const errors = validateGuestRow({ first_name: 'Ada', last_name: 'Okafor' });
    expect(errors.some((e) => e.columnName === 'email')).toBe(true);
  });

  it('rejects a malformed date_of_birth', () => {
    const errors = validateGuestRow({ first_name: 'Ada', last_name: 'Okafor', email: 'a@example.com', date_of_birth: '05/01/1990' });
    expect(errors.some((e) => e.columnName === 'date_of_birth')).toBe(true);
  });
});

describe('validateCompanyRow', () => {
  it('accepts a clean row', () => {
    expect(validateCompanyRow({ name: 'Acme', type: 'company' })).toEqual([]);
  });

  it('requires name', () => {
    expect(validateCompanyRow({}).some((e) => e.columnName === 'name')).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(validateCompanyRow({ name: 'Acme', type: 'nonsense' }).some((e) => e.columnName === 'type')).toBe(true);
  });
});

describe('validateReservationRow', () => {
  const okRefs = { guestMatch: 1, roomTypeExists: true, rateCodeExists: true };

  it('accepts a clean row', () => {
    const errors = validateReservationRow(
      { guest_email: 'a@example.com', room_type_code: 'DLX', rate_code: 'BAR', arrival_date: '2026-12-24', departure_date: '2026-12-25' },
      okRefs
    );
    expect(errors).toEqual([]);
  });

  it('flags an unresolved guest', () => {
    const errors = validateReservationRow(
      { guest_email: 'nobody@example.com', room_type_code: 'DLX', rate_code: 'BAR', arrival_date: '2026-12-24', departure_date: '2026-12-25' },
      { ...okRefs, guestMatch: null }
    );
    expect(errors.some((e) => e.columnName === 'guest_email')).toBe(true);
  });

  it('flags an ambiguous guest match distinctly', () => {
    const errors = validateReservationRow(
      { guest_email: 'shared@example.com', room_type_code: 'DLX', rate_code: 'BAR', arrival_date: '2026-12-24', departure_date: '2026-12-25' },
      { ...okRefs, guestMatch: 'ambiguous' }
    );
    expect(errors.some((e) => e.columnName === 'guest_email' && /more than one/i.test(e.message))).toBe(true);
  });

  it('flags an unknown room type code', () => {
    const errors = validateReservationRow(
      { guest_email: 'a@example.com', room_type_code: 'GHOST', rate_code: 'BAR', arrival_date: '2026-12-24', departure_date: '2026-12-25' },
      { ...okRefs, roomTypeExists: false }
    );
    expect(errors.some((e) => e.columnName === 'room_type_code')).toBe(true);
  });

  it('flags an unknown rate code', () => {
    const errors = validateReservationRow(
      { guest_email: 'a@example.com', room_type_code: 'DLX', rate_code: 'GHOST', arrival_date: '2026-12-24', departure_date: '2026-12-25' },
      { ...okRefs, rateCodeExists: false }
    );
    expect(errors.some((e) => e.columnName === 'rate_code')).toBe(true);
  });

  it('flags departure before arrival', () => {
    const errors = validateReservationRow(
      { guest_email: 'a@example.com', room_type_code: 'DLX', rate_code: 'BAR', arrival_date: '2026-12-25', departure_date: '2026-12-24' },
      okRefs
    );
    expect(errors.some((e) => e.columnName === 'departure_date')).toBe(true);
  });

  it('flags departure equal to arrival (a zero-length stay)', () => {
    const errors = validateReservationRow(
      { guest_email: 'a@example.com', room_type_code: 'DLX', rate_code: 'BAR', arrival_date: '2026-12-24', departure_date: '2026-12-24' },
      okRefs
    );
    expect(errors.some((e) => e.columnName === 'departure_date')).toBe(true);
  });

  it('flags an invalid date format', () => {
    const errors = validateReservationRow(
      { guest_email: 'a@example.com', room_type_code: 'DLX', rate_code: 'BAR', arrival_date: '24-12-2026', departure_date: '2026-12-25' },
      okRefs
    );
    expect(errors.some((e) => e.columnName === 'arrival_date')).toBe(true);
  });

  it('flags an unrecognised status value', () => {
    const errors = validateReservationRow(
      { guest_email: 'a@example.com', room_type_code: 'DLX', rate_code: 'BAR', arrival_date: '2026-12-24', departure_date: '2026-12-25', status: 'made_up' },
      okRefs
    );
    expect(errors.some((e) => e.columnName === 'status')).toBe(true);
  });
});

describe('validateArBalanceRow', () => {
  it('accepts a clean row', () => {
    expect(validateArBalanceRow({ company_email: 'acme@example.com', amount: '150.00', currency: 'NGN' }, { companyExists: true })).toEqual([]);
  });

  it('flags an unresolved company', () => {
    const errors = validateArBalanceRow({ company_email: 'ghost@example.com', amount: '150.00', currency: 'NGN' }, { companyExists: false });
    expect(errors.some((e) => e.columnName === 'company_email')).toBe(true);
  });

  it('rejects a zero or negative amount', () => {
    const errors = validateArBalanceRow({ company_email: 'acme@example.com', amount: '0.00', currency: 'NGN' }, { companyExists: true });
    expect(errors.some((e) => e.columnName === 'amount')).toBe(true);
  });

  it('rejects a malformed currency code', () => {
    const errors = validateArBalanceRow({ company_email: 'acme@example.com', amount: '150.00', currency: 'naira' }, { companyExists: true });
    expect(errors.some((e) => e.columnName === 'currency')).toBe(true);
  });

  it('rejects an unrecognised enforcement_mode', () => {
    const errors = validateArBalanceRow(
      { company_email: 'acme@example.com', amount: '150.00', currency: 'NGN', enforcement_mode: 'sometimes' },
      { companyExists: true }
    );
    expect(errors.some((e) => e.columnName === 'enforcement_mode')).toBe(true);
  });
});
