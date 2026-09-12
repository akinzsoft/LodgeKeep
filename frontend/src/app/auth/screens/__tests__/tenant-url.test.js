import { describe, it, expect } from 'vitest';
import { buildTenantLoginUrl } from '../tenant-url.js';

describe('buildTenantLoginUrl', () => {
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
