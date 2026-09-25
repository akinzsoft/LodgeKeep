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

// User-reported: Departments (and Calendar/Task) had no screen and bounced to
// Home when clicked. They are hidden until they exist.
describe('DEFAULT_NAV_GROUPS', () => {
  const keys = DEFAULT_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.key));

  it('lists no item that has no screen behind it', () => {
    expect(keys).not.toContain('departments');
    expect(keys).not.toContain('calendar');
    expect(keys).not.toContain('task');
  });

  it('has no empty group', () => {
    expect(DEFAULT_NAV_GROUPS.every((group) => group.items.length > 0)).toBe(true);
  });

  it('keeps Staff, which has a real screen', () => {
    expect(keys).toContain('staff');
  });
});
