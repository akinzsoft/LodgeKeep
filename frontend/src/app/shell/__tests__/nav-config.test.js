import { describe, it, expect } from 'vitest';
import { DEFAULT_NAV_GROUPS, isNavItemAllowed } from '../nav-config.js';

describe('isNavItemAllowed', () => {
  // Gap closure (user-reported): "staff" had no permission and no screen, so
  // every role clicked it and landed on Home. It is now gated on the key
  // `/users` reads require.
  it('gates the staff item on setup.view', () => {
    expect(isNavItemAllowed('staff', new Set(['setup.view']))).toBe(true);
    expect(isNavItemAllowed('staff', new Set(['reservations.view']))).toBe(false);
  });

  it('treats an unknown key as not allowed, so it is never silently shown as Home', () => {
    expect(isNavItemAllowed('no_such_screen', new Set(['setup.view']))).toBe(false);
  });

  it('opens ungated items to everyone, even with no permissions at all', () => {
    expect(isNavItemAllowed('home', new Set())).toBe(true);
  });

  it('opens a gated item only when its required permission is granted', () => {
    expect(isNavItemAllowed('setup', new Set(['setup.view']))).toBe(true);
    expect(isNavItemAllowed('setup', new Set(['reservations.view']))).toBe(false);
  });

  it('never allows an unknown key', () => {
    expect(isNavItemAllowed('not-a-screen', new Set(['setup.view']))).toBe(false);
  });

  it('matches every gated item in the default taxonomy to its own requiredPermission', () => {
    const gated = DEFAULT_NAV_GROUPS.flatMap((group) => group.items).filter((item) => item.requiredPermission);
    expect(gated.length).toBeGreaterThan(0);
    for (const item of gated) {
      expect(isNavItemAllowed(item.key, new Set([item.requiredPermission]))).toBe(true);
      expect(isNavItemAllowed(item.key, new Set())).toBe(false);
    }
  });
});
