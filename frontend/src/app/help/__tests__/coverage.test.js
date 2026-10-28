import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { DEFAULT_NAV_GROUPS } from '../../shell/nav-config.js';
import { GUIDES } from '../guides.js';
import { COVERAGE } from '../coverage.js';

// The tab lists live in the screen components, so they are read from the source rather
// than copied here: a new tab on any screen then fails this test until it is mapped.
const APP = join(cwd(), 'src', 'app');
const read = (path) => readFileSync(join(APP, path), 'utf8');

/** Labels of the `{ ..., label: '...' }` entries in `const NAME = [ ... ];`. */
function labelsInArray(source, name) {
  const start = source.indexOf(`const ${name} = [`);
  if (start === -1) return [];
  return labelsIn(source.slice(start, source.indexOf('\n];', start)));
}
function labelsIn(chunk) {
  return [...chunk.matchAll(/label:\s*(?:'([^']*)'|"([^"]*)")/g)].map((match) => match[1] ?? match[2]);
}
/** Label of `const NAME = { key: ..., label: '...' };`. */
function labelOfObject(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  return start === -1 ? [] : labelsIn(source.slice(start, source.indexOf('};', start)));
}
/** Labels in the supermarket's inline `const tabs = [ canX && { ... }, ... ].filter(Boolean)`. */
function supermarketTabs(source) {
  const start = source.indexOf('const tabs = [\n    canSell');
  return start === -1 ? [] : labelsIn(source.slice(start, source.indexOf('].filter(Boolean)', start)));
}

const reporting = read('reporting/ReportingScreen.jsx');
const TABS_BY_SCREEN = {
  booking: labelsInArray(read('booking/BookingScreen.jsx'), 'TABS'),
  profiles: labelsInArray(read('profiles/ProfilesScreen.jsx'), 'TABS'),
  rooms: labelsInArray(read('rooms/RoomsScreen.jsx'), 'TABS'),
  housekeeping: labelsInArray(read('housekeeping/HousekeepingScreen.jsx'), 'TABS'),
  cashiering: labelsInArray(read('cashiering/CashieringScreen.jsx'), 'TABS'),
  pos: labelsInArray(read('pos/POSScreen.jsx'), 'TABS'),
  stock: labelsInArray(read('pos/StockTab.jsx'), 'STOCK_TABS'),
  supermarket: supermarketTabs(read('supermarket/SupermarketScreen.jsx')),
  setup: labelsInArray(read('setup/SetupScreen.jsx'), 'TABS'),
  reports: [...labelOfObject(reporting, 'BUSINESS_TAB'), ...labelsInArray(reporting, 'TABS'), ...labelOfObject(reporting, 'DISCOUNTS_TAB')],
  ar: labelsInArray(read('ar/ARScreen.jsx'), 'TABS'),
  group_blocks: labelsInArray(read('group-blocks/GroupBlocksScreen.jsx'), 'TABS'),
  migration: labelsInArray(read('migration/DataMigrationScreen.jsx'), 'TABS'),
  door_access: labelsInArray(read('door-access/DoorAccessScreen.jsx'), 'TABS'),
  expenses: labelsInArray(read('expenses/ExpensesScreen.jsx'), 'TABS'),
};
// Screens opened from somewhere other than the sidebar.
const EXTRA_SCREENS = ['my_profile'];

const NAV_KEYS = DEFAULT_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.key));
const SCREENS = [...NAV_KEYS, ...EXTRA_SCREENS];
const entryFor = (screen, tab) => COVERAGE.find((entry) => entry.screen === screen && entry.tab === tab);
const label = (screen, tab) => (tab === null ? screen : `${screen} → ${tab}`);

const planned = COVERAGE.filter((entry) => entry.status === 'planned');

describe(`Help coverage map (${planned.length} of ${COVERAGE.length} entries still planned)`, () => {
  it('reports how many screens and tabs still have no guide', () => {
    console.info(`Help coverage: ${COVERAGE.length - planned.length} covered, ${planned.length} planned, ${COVERAGE.length} in total.`);
    expect(planned.length).toBeGreaterThanOrEqual(0);
  });

  it('can read the tab list of every screen that has tabs', () => {
    for (const [screen, tabs] of Object.entries(TABS_BY_SCREEN)) expect(tabs.length, `no tabs found for ${screen}`).toBeGreaterThan(1);
  });

  it('has an entry for every sidebar item and the top-bar screens', () => {
    for (const screen of SCREENS) expect(entryFor(screen, null), `no coverage entry for the ${screen} screen`).toBeDefined();
  });

  it('has an entry for every sub-tab found in the screen components', () => {
    for (const [screen, tabs] of Object.entries(TABS_BY_SCREEN)) {
      for (const tab of tabs) expect(entryFor(screen, tab), `no coverage entry for ${label(screen, tab)}`).toBeDefined();
    }
  });

  it('has no entry for a screen or tab that no longer exists', () => {
    for (const entry of COVERAGE) {
      expect(SCREENS, `${entry.screen} is not a screen`).toContain(entry.screen);
      if (entry.tab !== null) expect(TABS_BY_SCREEN[entry.screen] ?? [], `${label(entry.screen, entry.tab)} is not a tab`).toContain(entry.tab);
    }
  });

  it('lists each screen and tab once', () => {
    const keys = COVERAGE.map((entry) => label(entry.screen, entry.tab));
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });

  it('only points a covered entry at guides that exist', () => {
    for (const entry of COVERAGE) {
      if (entry.status === 'covered') {
        expect(entry.guides.length, `${label(entry.screen, entry.tab)} is covered but names no guide`).toBeGreaterThan(0);
        for (const slug of entry.guides) expect(GUIDES[slug], `${label(entry.screen, entry.tab)} names a guide that does not exist: ${slug}`).toBeDefined();
      } else {
        expect(entry.status).toBe('planned');
        expect(entry.guides).toEqual([]);
      }
    }
  });

  it('marks a whole screen covered only when all of its tabs are', () => {
    for (const [screen, tabs] of Object.entries(TABS_BY_SCREEN)) {
      const allCovered = tabs.every((tab) => entryFor(screen, tab)?.status === 'covered');
      if (entryFor(screen, null)?.status === 'covered') expect(allCovered, `${screen} is marked covered but has a planned tab`).toBe(true);
    }
  });
});
