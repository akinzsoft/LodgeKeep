'use strict';

/**
 * Direct, pure-function tests for `isSameOrigin` — security-review finding,
 * `same-origin-guard.js`'s own header has the full reasoning. HTTP-level
 * proof that the middleware is actually wired onto `/auth/refresh` and
 * `/auth/logout` lives in `tests/auth/auth.test.js`'s own "CSRF defense-
 * in-depth" describe block.
 */

const { isSameOrigin } = require('../../src/auth/same-origin-guard');

function req(headers) {
  return { headers };
}

describe('isSameOrigin', () => {
  it('allows a request with neither Origin nor Referer — SameSite=Lax is the real defense, this is additional depth', () => {
    expect(isSameOrigin(req({ host: 'alpha-hotels.lodgekeep.app' }))).toBe(true);
  });

  it('allows a genuinely matching Origin', () => {
    expect(isSameOrigin(req({ host: 'alpha-hotels.lodgekeep.app', origin: 'https://alpha-hotels.lodgekeep.app' }))).toBe(true);
  });

  it('rejects a mismatched Origin', () => {
    expect(isSameOrigin(req({ host: 'alpha-hotels.lodgekeep.app', origin: 'https://attacker.example' }))).toBe(false);
  });

  it('rejects a malformed Origin header rather than treating it as absent', () => {
    expect(isSameOrigin(req({ host: 'alpha-hotels.lodgekeep.app', origin: 'not a url' }))).toBe(false);
  });

  it('falls back to Referer when Origin is absent, and allows a genuine match', () => {
    expect(isSameOrigin(req({ host: 'alpha-hotels.lodgekeep.app', referer: 'https://alpha-hotels.lodgekeep.app/booking' }))).toBe(true);
  });

  it('falls back to Referer when Origin is absent, and rejects a mismatch', () => {
    expect(isSameOrigin(req({ host: 'alpha-hotels.lodgekeep.app', referer: 'https://attacker.example/phish' }))).toBe(false);
  });

  it('rejects a malformed Referer rather than treating it as absent', () => {
    expect(isSameOrigin(req({ host: 'alpha-hotels.lodgekeep.app', referer: 'not a url' }))).toBe(false);
  });

  it('prefers Origin over Referer when both are present', () => {
    expect(
      isSameOrigin(
        req({ host: 'alpha-hotels.lodgekeep.app', origin: 'https://alpha-hotels.lodgekeep.app', referer: 'https://attacker.example/phish' })
      )
    ).toBe(true);
  });
});
