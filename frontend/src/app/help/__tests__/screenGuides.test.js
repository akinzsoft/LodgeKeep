import { describe, it, expect } from 'vitest';
import { GUIDES, getGuide } from '../guides.js';
import { SCREEN_GROUPS, listScreenGuideGroups } from '../screenGroups.js';

const SCREEN_GUIDES = Object.values(GUIDES).filter((guide) => guide.slug.startsWith('screens/'));
const REQUIRED_HEADINGS = ['What it is for', 'Who can do this', 'Where to click', 'Fields that matter', 'You are done when', 'What can go wrong'];

describe('"How to use each screen" guides', () => {
  it('has the first four guides', () => {
    expect(SCREEN_GUIDES.map((guide) => guide.slug).sort()).toEqual([
      'screens/cashiering-and-money/01-cashiering-folios',
      'screens/restaurant-and-bar/01-selling-at-the-register',
      'screens/restaurant-and-bar/02-opening-and-closing-a-shift',
      'screens/restaurant-and-bar/03-voids-and-card-refunds',
    ]);
  });

  it.each(SCREEN_GUIDES.map((guide) => [guide.slug, guide]))('%s parses cleanly, has the template headings and a screenshot', (slug, guide) => {
    expect(guide.problems).toEqual([]);
    expect(guide.images.length).toBeGreaterThan(0);
    for (const file of guide.images.map((image) => image.file)) expect(file.startsWith('screens/')).toBe(true);
    const headings = [...guide.source.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
    for (const heading of REQUIRED_HEADINGS) expect(headings, `${slug} needs "${heading}"`).toContain(heading);
  });

  it('only links to guides that exist', () => {
    for (const guide of SCREEN_GUIDES) {
      for (const [, target] of guide.source.matchAll(/\]\(help:([^)]+)\)/g)) expect(getGuide(target), `${guide.slug} links to ${target}`).not.toBeNull();
    }
  });

  it('lives in a known work-area folder, so it is listed', () => {
    const folders = new Set(SCREEN_GROUPS.map((group) => group.folder));
    for (const guide of SCREEN_GUIDES) expect(folders.has(guide.slug.split('/')[1]), guide.slug).toBe(true);
  });

  it('groups guides by work area, in order, hiding empty groups', () => {
    const groups = listScreenGuideGroups();
    expect(groups.map((group) => group.label)).toEqual(['Cashiering and money', 'Restaurant and bar']);
    expect(groups[1].guides.map((guide) => guide.title)).toEqual(['Selling at the Register', 'Opening and closing a shift', 'Voids and card refunds from Sales']);
  });
});
