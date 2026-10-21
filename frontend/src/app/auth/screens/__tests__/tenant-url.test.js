import { describe, it, expect } from 'vitest';
import { buildTenantLoginUrl } from '../tenant-url.js';

describe('buildTenantLoginUrl', () => {
  // No VITE_APP_DOMAIN configured (the local-dev shape — frontend/.env.example
  // leaves it unset) — falls back to the old label-counting guess, which is
  // unambiguous only because dev's own APP_DOMAIN is the single label
  // "localhost".
  describe('without a configured VITE_APP_DOMAIN (local dev fallback)', () => {
    it('builds a subdomain from a bare localhost origin', () => {
      const url = buildTenantLoginUrl('riverside', { hostname: 'localhost', protocol: 'http:', port: '5173' });
      expect(url).toBe('http://riverside.localhost:5173/');
    });

    it('replaces an existing subdomain rather than prepending onto it', () => {
      const url = buildTenantLoginUrl('riverside', { hostname: 'alpha-hotels.localhost', protocol: 'http:', port: '5173' });
      expect(url).toBe('http://riverside.localhost:5173/');
    });

    it('replaces the first label under a real production apex domain', () => {
      const url = buildTenantLoginUrl('riverside', { hostname: 'app.lodgekeep.app', protocol: 'https:', port: '' });
      expect(url).toBe('https://riverside.lodgekeep.app/');
    });

    it('omits the port when none is set', () => {
      const url = buildTenantLoginUrl('riverside', { hostname: 'localhost', protocol: 'http:', port: '' });
      expect(url).toBe('http://riverside.localhost/');
    });

    it('returns null with no location available', () => {
      expect(buildTenantLoginUrl('riverside', null)).toBeNull();
    });
  });

  // A real production bug, user-reported: APP_DOMAIN is itself a
  // multi-level subdomain (lodgekeep.planmsys.com, not a bare
  // single-label domain like lodgekeep.app). The old label-counting guess
  // stripped "lodgekeep" off as though it were a tenant subdomain to
  // replace, producing alpha-motel.planmsys.com instead of
  // alpha-motel.lodgekeep.planmsys.com. With the real APP_DOMAIN known
  // (VITE_APP_DOMAIN), the slug is always prefixed onto it verbatim.
  describe('with a configured VITE_APP_DOMAIN', () => {
    const APP_DOMAIN = 'lodgekeep.planmsys.com';

    it('prefixes the slug onto a multi-level APP_DOMAIN verbatim, stripping nothing', () => {
      const url = buildTenantLoginUrl(
        'alpha-motel',
        { hostname: 'lodgekeep.planmsys.com', protocol: 'https:', port: '' },
        APP_DOMAIN,
      );
      expect(url).toBe('https://alpha-motel.lodgekeep.planmsys.com/');
    });

    it('replaces one existing tenant subdomain of a multi-level APP_DOMAIN, never nesting it', () => {
      const url = buildTenantLoginUrl(
        'riverside',
        { hostname: 'alpha-hotels.lodgekeep.planmsys.com', protocol: 'https:', port: '' },
        APP_DOMAIN,
      );
      expect(url).toBe('https://riverside.lodgekeep.planmsys.com/');
    });

    it('still works for a bare single-label APP_DOMAIN', () => {
      const url = buildTenantLoginUrl(
        'riverside',
        { hostname: 'lodgekeep.app', protocol: 'https:', port: '' },
        'lodgekeep.app',
      );
      expect(url).toBe('https://riverside.lodgekeep.app/');
    });

    it('matches the hostname against APP_DOMAIN case-insensitively', () => {
      const url = buildTenantLoginUrl(
        'alpha-motel',
        { hostname: 'LodgeKeep.PlanMsys.com', protocol: 'https:', port: '' },
        APP_DOMAIN,
      );
      expect(url).toBe('https://alpha-motel.lodgekeep.planmsys.com/');
    });

    it('falls back to the label-counting guess for a host unrelated to APP_DOMAIN (e.g. a tenant custom domain)', () => {
      const url = buildTenantLoginUrl(
        'riverside',
        { hostname: 'book.some-other-hotel-group.com', protocol: 'https:', port: '' },
        APP_DOMAIN,
      );
      // Doesn't match `lodgekeep.planmsys.com` at all, so this is the same
      // fallback the "without a configured VITE_APP_DOMAIN" cases above use.
      expect(url).toBe('https://riverside.some-other-hotel-group.com/');
    });
  });
  // Two-domain support: the slug always goes onto the PRIMARY, from any accepted host.
  describe('with a primary and additional accepted domains', () => {
    const PRIMARY = 'lodgekeep.ng';
    const ADDITIONAL = 'lodgekeep.planmsys.com';
    const build = (hostname, port = '') => buildTenantLoginUrl('alpha-motel', { hostname, protocol: 'https:', port }, PRIMARY, ADDITIONAL);

    it('signing up from the new bare domain builds <slug>.lodgekeep.ng, never <slug>.ng', () => {
      expect(build('lodgekeep.ng')).toBe('https://alpha-motel.lodgekeep.ng/');
    });

    it('signing up from the OLD bare domain also goes to the primary', () => {
      expect(build('lodgekeep.planmsys.com')).toBe('https://alpha-motel.lodgekeep.ng/');
    });

    it('a tenant host on either domain gets its slug replaced, never nested', () => {
      expect(build('riverside.lodgekeep.ng')).toBe('https://alpha-motel.lodgekeep.ng/');
      expect(build('riverside.lodgekeep.planmsys.com')).toBe('https://alpha-motel.lodgekeep.ng/');
    });

    it('is case-insensitive', () => {
      expect(build('LodgeKeep.NG')).toBe('https://alpha-motel.lodgekeep.ng/');
    });

    it('a lookalike or multi-label host is NOT treated as accepted (falls to the old guess)', () => {
      expect(build('x.lodgekeep.ng.evil.com')).not.toContain('.lodgekeep.ng/');
      expect(build('evillodgekeep.ng')).toBe('https://alpha-motel.ng/');
    });

    it('with only the old domain configured (additional not yet set) the new host is unaccepted, as before', () => {
      expect(buildTenantLoginUrl('alpha-motel', { hostname: 'lodgekeep.ng', protocol: 'https:', port: '' }, 'lodgekeep.planmsys.com')).toBe('https://alpha-motel.ng/');
    });

    it('ignores a malformed additional entry instead of widening what is accepted', () => {
      expect(buildTenantLoginUrl('alpha-motel', { hostname: 'lodgekeep.ng', protocol: 'https:', port: '' }, 'lodgekeep.planmsys.com', '*.lodgekeep.ng,https://lodgekeep.ng')).toBe('https://alpha-motel.ng/');
    });
  });
});
