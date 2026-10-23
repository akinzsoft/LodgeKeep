'use strict';

const { normalizeTimeZone, assertValidTimeZone } = require('../../src/shared/timezone');

describe('normalizeTimeZone / assertValidTimeZone', () => {
  it('accepts every zone Intl lists, unchanged', () => {
    for (const zone of Intl.supportedValuesOf('timeZone')) expect(normalizeTimeZone(zone)).toBe(zone);
  });

  it('returns the canonical name for a case variant of a real zone', () => {
    expect(normalizeTimeZone('africa/lagos')).toBe('Africa/Lagos');
  });

  it.each(['Africa/Asaba', 'Benin/ Edo State', 'Africa', 'Lagos', 'LAGOS', 'lagos', 'African/delta', '', ' ', ' Africa/Lagos', null, undefined, 5])(
    'rejects %j',
    (value) => {
      expect(normalizeTimeZone(value)).toBeNull();
      expect(() => assertValidTimeZone(value)).toThrow(expect.objectContaining({ code: 'VALIDATION_INVALID_TIMEZONE', httpStatus: 400 }));
    }
  );
});
