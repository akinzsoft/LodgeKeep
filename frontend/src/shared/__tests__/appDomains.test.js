import { describe, it, expect } from 'vitest';
import { parseAppDomains, isAcceptedAppHost } from '../appDomains.js';

describe('parseAppDomains', () => {
  it('puts the primary first and keeps the additional ones, lower-cased, without duplicates', () => {
    expect(parseAppDomains(' LodgeKeep.NG ', 'lodgekeep.planmsys.com, LODGEKEEP.NG ,,')).toEqual({ primary: 'lodgekeep.ng', all: ['lodgekeep.ng', 'lodgekeep.planmsys.com'] });
  });

  it('drops malformed entries instead of repairing them', () => {
    expect(parseAppDomains('lodgekeep.ng', '*.a.com,https://b.com,c.com:80,d.com/x,e..com,-f.com, ').all).toEqual(['lodgekeep.ng']);
  });

  it('nothing configured accepts nothing', () => {
    expect(parseAppDomains(undefined, 'lodgekeep.ng')).toEqual({ primary: null, all: ['lodgekeep.ng'] });
    expect(parseAppDomains('', '')).toEqual({ primary: null, all: [] });
  });
});

describe('isAcceptedAppHost', () => {
  const domains = ['lodgekeep.ng', 'lodgekeep.planmsys.com'];
  it.each(['lodgekeep.ng', 'alpha.lodgekeep.ng', 'LODGEKEEP.PLANMSYS.COM', 'alpha.lodgekeep.planmsys.com.'])('accepts %s', (host) => {
    expect(isAcceptedAppHost(host, domains)).toBe(true);
  });
  it.each(['x.lodgekeep.ng.evil.com', 'lodgekeep.ng.evil.com', 'evillodgekeep.ng', 'a.b.lodgekeep.ng', 'ng', '', undefined])('rejects %s', (host) => {
    expect(isAcceptedAppHost(host, domains)).toBe(false);
  });
});
