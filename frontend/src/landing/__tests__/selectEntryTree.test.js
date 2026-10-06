import { describe, it, expect } from 'vitest';
import { isMarketingHost, selectEntryTree } from '../selectEntryTree.js';

const APP_DOMAIN = 'lodgekeep.planmsys.com';
// `appDomain` is only defaulted when the argument is ABSENT, so a test can pass undefined/null/'' on purpose.
const pick = (hostname, pathname = '/', ...rest) => selectEntryTree({ hostname, pathname, appDomain: rest.length ? rest[0] : APP_DOMAIN });

describe('selectEntryTree — the landing page is the bare host only', () => {
  it('shows the landing page at the exact bare domain, path /', () => {
    expect(pick('lodgekeep.planmsys.com')).toBe('landing');
  });

  it('matches case-insensitively and with a trailing DNS dot', () => {
    expect(pick('LodgeKeep.Planmsys.COM')).toBe('landing');
    expect(pick('lodgekeep.planmsys.com.')).toBe('landing');
  });

  it.each([
    'alpha-motel.lodgekeep.planmsys.com',
    'stical-hotel-suite.lodgekeep.planmsys.com',
    'isaac-hotel.lodgekeep.planmsys.com',
    'a-future-tenant.lodgekeep.planmsys.com',
    'www.lodgekeep.planmsys.com', // www is deliberately NOT the marketing host
    'ALPHA-MOTEL.LODGEKEEP.PLANMSYS.COM',
    'alpha-motel.lodgekeep.planmsys.com.',
    'deep.sub.lodgekeep.planmsys.com',
  ])('a tenant subdomain (%s) always gets the app, never the landing page', (host) => {
    expect(pick(host)).toBe('app');
  });

  it.each([
    'lodgekeep.planmsys.com.evil.com',
    'evillodgekeep.planmsys.com',
    'xlodgekeep.planmsys.com',
    'lodgekeep-planmsys.com',
    'planmsys.com',
    'www.planmsys.com',
    'localhost',
    '127.0.0.1',
    'lodgekeep.planmsys.com:5173', // a hostname never carries a port; if one ever does, it is not a match
    '',
  ])('a lookalike or unrelated host (%s) is not the marketing host', (host) => {
    expect(pick(host)).toBe('app');
  });

  it('a customer own-domain host gets the app', () => {
    expect(pick('pms.stical-suites.com')).toBe('app');
  });

  it('shows the landing page ONLY at the path "/"', () => {
    for (const path of ['/index.html', '/pricing', '/login', '/welcome', '//', '/ ']) {
      expect(pick('lodgekeep.planmsys.com', path)).toBe('app');
    }
  });

  it('keeps /signup, /platform, /portal and /qr-order working on the bare host', () => {
    expect(pick('lodgekeep.planmsys.com', '/signup')).toBe('signup');
    expect(pick('lodgekeep.planmsys.com', '/platform')).toBe('platform');
    expect(pick('lodgekeep.planmsys.com', '/platform/tenants')).toBe('platform');
    expect(pick('lodgekeep.planmsys.com', '/portal/alpha/book')).toBe('portal');
    expect(pick('lodgekeep.planmsys.com', '/qr-order/abc')).toBe('qr-order');
  });

  it('picks the same trees as before for every other host and path', () => {
    for (const host of ['alpha-motel.lodgekeep.planmsys.com', 'lodgekeep.planmsys.com']) {
      expect(pick(host, '/portalx')).toBe('portal');
      expect(pick(host, '/platform')).toBe('platform');
      expect(pick(host, '/qr-order/x')).toBe('qr-order');
      expect(pick(host, '/signup')).toBe('signup');
    }
    expect(pick('alpha-motel.lodgekeep.planmsys.com', '/')).toBe('app');
    expect(pick('alpha-motel.lodgekeep.planmsys.com', '/anything/else')).toBe('app');
  });

  it('with no app domain configured nothing is the marketing host — the app always wins', () => {
    for (const appDomain of [undefined, null, '', '   ']) {
      expect(pick('lodgekeep.planmsys.com', '/', appDomain)).toBe('app');
      expect(pick('localhost', '/', appDomain)).toBe('app');
      expect(pick('', '/', appDomain)).toBe('app');
    }
  });

  it('works in local dev with the app domain set to localhost: bare localhost is the landing page, tenant hosts are not', () => {
    expect(pick('localhost', '/', 'localhost')).toBe('landing');
    expect(pick('alpha-hotels.localhost', '/', 'localhost')).toBe('app');
    expect(pick('demo-lagos-grand.localhost', '/', 'localhost')).toBe('app');
  });
});

describe('isMarketingHost', () => {
  it('is exact equality, nothing looser', () => {
    expect(isMarketingHost('lodgekeep.planmsys.com', 'lodgekeep.planmsys.com')).toBe(true);
    expect(isMarketingHost('a.lodgekeep.planmsys.com', 'lodgekeep.planmsys.com')).toBe(false);
    expect(isMarketingHost('lodgekeep.planmsys.com', 'a.lodgekeep.planmsys.com')).toBe(false);
    expect(isMarketingHost('lodgekeep.planmsys.com.x', 'lodgekeep.planmsys.com')).toBe(false);
    expect(isMarketingHost(undefined, 'lodgekeep.planmsys.com')).toBe(false);
  });
});
