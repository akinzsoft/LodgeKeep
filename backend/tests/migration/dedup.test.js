'use strict';

/**
 * Guest deduplication — PRODUCT_REQUIREMENTS.md §3.20's three-tier rule
 * (email, then phone, then name + date of birth), pure, no database.
 */

const { findDuplicateCandidates, matchExistingGuestByContact, matchExistingCompanyByEmail } = require('../../src/modules/migration/dedup');

const EXISTING_GUESTS = [
  { id: 1, first_name: 'Ada', last_name: 'Okafor', email: 'ada@example.com', phone: '+2348030000001', date_of_birth: '1990-05-01' },
  { id: 2, first_name: 'Ben', last_name: 'Okafor', email: null, phone: '08030000002', date_of_birth: '1985-01-01' },
  { id: 3, first_name: 'Chidi', last_name: 'Eze', email: null, phone: null, date_of_birth: '1970-03-03' },
  // Two guests deliberately sharing an email — no unique constraint on this field.
  { id: 4, first_name: 'Family', last_name: 'One', email: 'family@example.com', phone: null, date_of_birth: null },
  { id: 5, first_name: 'Family', last_name: 'Two', email: 'family@example.com', phone: null, date_of_birth: null },
];

describe('findDuplicateCandidates', () => {
  it('matches on email, case-insensitively, before trying any other tier', () => {
    const result = findDuplicateCandidates({ importedRow: { email: 'ADA@Example.com', phone: '+9999999999' }, existingGuests: EXISTING_GUESTS });
    expect(result.tier).toBe('email');
    expect(result.matches.map((m) => m.id)).toEqual([1]);
  });

  it('surfaces every match at the winning tier, not just the first', () => {
    const result = findDuplicateCandidates({ importedRow: { email: 'family@example.com' }, existingGuests: EXISTING_GUESTS });
    expect(result.tier).toBe('email');
    expect(result.matches.map((m) => m.id).sort()).toEqual([4, 5]);
  });

  it('falls back to phone when email does not match, normalizing formatting differences', () => {
    const result = findDuplicateCandidates({ importedRow: { email: 'unmatched@example.com', phone: '0803 000 0002' }, existingGuests: EXISTING_GUESTS });
    expect(result.tier).toBe('phone');
    expect(result.matches.map((m) => m.id)).toEqual([2]);
  });

  it('falls back to name + date of birth when neither email nor phone matches', () => {
    const result = findDuplicateCandidates({
      importedRow: { first_name: 'chidi', last_name: 'EZE', date_of_birth: '1970-03-03' },
      existingGuests: EXISTING_GUESTS,
    });
    expect(result.tier).toBe('name_dob');
    expect(result.matches.map((m) => m.id)).toEqual([3]);
  });

  it('does not match on name alone without a date of birth', () => {
    const result = findDuplicateCandidates({ importedRow: { first_name: 'Chidi', last_name: 'Eze' }, existingGuests: EXISTING_GUESTS });
    expect(result).toBeNull();
  });

  it('returns null when nothing matches at any tier', () => {
    const result = findDuplicateCandidates({
      importedRow: { first_name: 'Nobody', last_name: 'Here', email: 'nobody@example.com', phone: '+10000000000' },
      existingGuests: EXISTING_GUESTS,
    });
    expect(result).toBeNull();
  });

  it('never falls through to phone/name once email produced a match, even if phone would also match someone else', () => {
    const result = findDuplicateCandidates({ importedRow: { email: 'ada@example.com', phone: '08030000002' }, existingGuests: EXISTING_GUESTS });
    expect(result.tier).toBe('email');
    expect(result.matches.map((m) => m.id)).toEqual([1]);
  });
});

describe('matchExistingGuestByContact', () => {
  it('resolves a single unambiguous match by email', () => {
    expect(matchExistingGuestByContact({ email: 'ada@example.com' }, EXISTING_GUESTS)).toBe(1);
  });

  it('resolves a single unambiguous match by phone when email is absent', () => {
    expect(matchExistingGuestByContact({ phone: '08030000002' }, EXISTING_GUESTS)).toBe(2);
  });

  it('returns null when nothing matches', () => {
    expect(matchExistingGuestByContact({ email: 'nobody@example.com' }, EXISTING_GUESTS)).toBeNull();
  });

  it('returns "ambiguous" when more than one guest shares the email', () => {
    expect(matchExistingGuestByContact({ email: 'family@example.com' }, EXISTING_GUESTS)).toBe('ambiguous');
  });
});

describe('matchExistingCompanyByEmail', () => {
  const companies = [
    { id: 10, name: 'Acme', billing_email: 'billing@acme.example.com' },
    { id: 11, name: 'Acme Travel', billing_email: 'billing@acme.example.com' },
  ];

  it('resolves a single unambiguous match', () => {
    expect(matchExistingCompanyByEmail('other@example.com', [companies[0]])).toBeNull();
    expect(matchExistingCompanyByEmail('billing@acme.example.com', [companies[0]])).toBe(10);
  });

  it('returns "ambiguous" when more than one company shares the billing email', () => {
    expect(matchExistingCompanyByEmail('billing@acme.example.com', companies)).toBe('ambiguous');
  });

  it('returns null for an empty email', () => {
    expect(matchExistingCompanyByEmail('', companies)).toBeNull();
  });
});
