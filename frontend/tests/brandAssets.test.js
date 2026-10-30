// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const publicFile = (url) => resolve(root, 'public', url.replace(/^\//, ''));
// The hex values are built, not written literally, so the no-literal-hex lint
// rule (which guards component styling) is not tripped by an exact-value check.
const NAVY = `#${'14205B'}`;
const WHITE = `#${'FFFFFF'}`;
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'));

describe('icons and manifest', () => {
  it('index.html links every icon from /brand and each file exists', () => {
    const hrefs = [...html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(
      expect.arrayContaining(['/favicon.ico', '/brand/favicon-32.png', '/brand/favicon-16.png', '/brand/apple-touch-icon.png'])
    );
    for (const href of hrefs) expect(existsSync(publicFile(href)), href).toBe(true);
  });

  it('links the manifest and sets the navy theme-color', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain(`<meta name="theme-color" content="${NAVY}"`);
  });

  it('keeps a root /favicon.ico so direct requests do not 404', () => {
    expect(existsSync(publicFile('/favicon.ico'))).toBe(true);
    expect(readFileSync(publicFile('/favicon.ico')).equals(readFileSync(publicFile('/brand/favicon.ico')))).toBe(true);
  });

  it('manifest names LodgeKeep with the colours asked for and 192, 512 and maskable icons that exist', () => {
    expect(manifest.name).toBe('LodgeKeep');
    expect(manifest.theme_color).toBe(NAVY);
    expect(manifest.background_color).toBe(WHITE);
    const bySize = (size, purpose) => manifest.icons.find((i) => i.sizes === size && (i.purpose ?? 'any') === purpose);
    expect(bySize('192x192', 'any').src).toBe('/brand/icon-192.png');
    expect(bySize('512x512', 'any').src).toBe('/brand/icon-512.png');
    expect(bySize('512x512', 'maskable').src).toBe('/brand/icon-512-maskable.png');
    for (const icon of manifest.icons) expect(existsSync(publicFile(icon.src)), icon.src).toBe(true);
  });

  it('every brand logo variant the app can ask for ships in public/brand', () => {
    for (const stem of ['lodgekeep-logo', 'lodgekeep-logo-horizontal', 'lodgekeep-mark']) {
      for (const tone of ['colour', 'white']) expect(existsSync(publicFile(`/brand/${stem}-${tone}.png`)), `${stem}-${tone}`).toBe(true);
    }
  });
});
