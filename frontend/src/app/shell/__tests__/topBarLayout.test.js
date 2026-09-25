import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

/**
 * jsdom has no layout, so it cannot tell that the top bar's single row is too
 * narrow. This pins the rule found in a tablet/phone check: below about 900px
 * the date and property chips move to their own full-width row, because on one
 * row the property name was cut to "Alpha…" or squeezed to its icon (and two
 * properties of one chain differ only in the part that gets cut).
 */
const css = readFileSync(join(cwd(), 'src/app/shell/TopBar.module.css'), 'utf8');

describe('top bar responsive layout (CSS rules)', () => {
  it('wraps the date and property chips onto their own row at 899px and below', () => {
    const start = css.indexOf('@media (width <= 899px) {');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('\n}\n', start));
    expect(block).toMatch(/flex-wrap:\s*wrap/);
    expect(block).toMatch(/\.context\s*{[^}]*flex:\s*1 0 100%/);
  });

  it('leaves the chip wrapper transparent to layout on desktop', () => {
    expect(css).toMatch(/\.context\s*{\s*display:\s*contents;/);
  });
});
