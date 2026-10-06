import { describe, it, expect } from 'vitest';
import source from '../../main.jsx?raw';

/**
 * `main.jsx` has no unit tests (it mounts the whole app on import), so the one
 * piece of wiring that keeps the landing page off every tenant host is pinned
 * here by reading the source: the entry tree must come from `selectEntryTree`
 * (which is tested), the landing page must stay lazy so staff devices never
 * download it, and `main.jsx` must make no host decision of its own.
 */
describe('main.jsx entry wiring', () => {
  it('chooses the tree only through selectEntryTree, with the build-time app domain', () => {
    expect(source).toMatch(/import \{ selectEntryTree \} from '\.\/landing\/selectEntryTree\.js'/);
    expect(source).toMatch(/selectEntryTree\(\{\s*hostname: window\.location\.hostname,\s*pathname: window\.location\.pathname,\s*appDomain: import\.meta\.env\.VITE_APP_DOMAIN,?\s*\}\)/);
  });

  it('loads the landing page lazily (never in the staff app bundle)', () => {
    expect(source).toMatch(/lazy\(\(\) => import\('\.\/landing\/LandingApp\.jsx'\)\)/);
    expect(source).not.toMatch(/^import .*landing\/LandingApp/m);
  });

  it('makes no host decision of its own, and the pathname chain is gone from the render', () => {
    expect(source).not.toMatch(/location\.hostname\s*(===|==|\.endsWith|\.includes|\.startsWith)/);
    expect(source).not.toMatch(/pathname\.startsWith\('\/portal'\) \?/);
  });
});
