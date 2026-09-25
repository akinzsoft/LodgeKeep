import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

/**
 * jsdom has no layout, so it cannot measure a button. This pins the CSS RULES
 * that make the POS register usable on a touch device — found in a mobile/POS
 * layout check where the ticket's quantity and void buttons were 26px and the
 * checkout button sat below the fold. Real sizes were re-measured in a browser;
 * this keeps a later edit from quietly shrinking them again.
 *
 * DESIGN_SYSTEM.md §1 "Touch targets": 44x44px minimum (`--control-h-touch`);
 * PRODUCT_REQUIREMENTS.md §3.4: the register aims for 64px+ (`--control-h-pos`)
 * on its primary controls.
 */
// Vitest runs from the frontend root; `import.meta.url` is not a file: URL under its jsdom environment.
const css = readFileSync(join(cwd(), 'src/app/pos/RegisterTab.module.css'), 'utf8');

/** The declaration block of the first rule whose selector is exactly `selector` (not a state or media variant of it). */
function rule(selector) {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`No rule for ${selector} in RegisterTab.module.css`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

const declaration = (block, property) => block.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`))?.[1].trim();

describe('POS register touch targets and layout (CSS rules)', () => {
  it.each(['.stepperButton', '.removeButton'])('%s (a ticket line control) is at least 44x44', (selector) => {
    const block = rule(selector);
    expect(declaration(block, 'width')).toBe('var(--control-h-touch)');
    expect(declaration(block, 'height')).toBe('var(--control-h-touch)');
  });

  it.each(['.renameLink', '.splitLink', '.roomChargeLink'])('%s (a text link the cashier taps) is at least 44px tall', (selector) => {
    expect(declaration(rule(selector), 'min-height')).toBe('var(--control-h-touch)');
  });

  it('the menu card, checkout button and order-bar button are at least 64px tall', () => {
    for (const selector of ['.menuCard', '.checkoutButton', '.orderBarButton']) {
      expect(declaration(rule(selector), 'min-height'), selector).toBe('var(--control-h-pos)');
    }
  });

  it('the menu card is a full-width button with no double-tap-zoom delay', () => {
    const block = rule('.menuCard');
    expect(declaration(block, 'width')).toBe('100%');
    expect(declaration(block, 'touch-action')).toBe('manipulation');
  });

  it('the checkout form is pinned to the bottom of the ticket, so the total and checkout button never scroll out of reach', () => {
    const block = rule('.checkoutForm');
    expect(declaration(block, 'position')).toBe('sticky');
    expect(declaration(block, 'bottom')).toBe('0');
    expect(declaration(block, 'background')).toBeTruthy(); // opaque, or lines would show through it
  });

  it('the wide panel never grows taller than the room left on screen', () => {
    expect(css).toMatch(/height:\s*min\(78vh,\s*calc\(100dvh\s*-\s*9rem\)\)/);
  });

  it('the pinned order bar is FIXED to the bottom of the screen (sticky never pinned: the shell\'s <main> is overflow:auto but the window is what scrolls), with a spacer, and hidden where the ticket sits beside the menu', () => {
    const bar = rule('.orderBar');
    expect(declaration(bar, 'position')).toBe('fixed');
    expect(declaration(bar, 'bottom')).toBe('0');
    expect(declaration(bar, 'left')).toBe('0');
    expect(declaration(bar, 'right')).toBe('0');
    expect(css).toMatch(/@media \(width >= 900px\)\s*\{\s*\.orderBar,\s*\.orderBarSpacer\s*\{\s*display:\s*none;/);
    expect(rule('.orderBarSpacer')).toMatch(/height:/);
  });

  // The rail is an 88px grid column and a rail item is 68px wide. With 12px side
  // padding (68 + 24 = 92) the desktop rail overflowed by 4px and drew a
  // horizontal scrollbar wherever scrollbars take space.
  it('the desktop category rail is narrow enough for its items and never scrolls sideways', () => {
    const media = css.slice(css.indexOf('@media (width >= 900px) {\n  .rail {'));
    const block = media.slice(media.indexOf('.rail {'), media.indexOf('}', media.indexOf('.rail {')));
    expect(declaration(block, 'padding')).toBe('var(--space-3) var(--space-2)');
    expect(declaration(block, 'overflow')).toBe('hidden auto');
  });
});

