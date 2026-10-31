import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandLogo, brandLogoSrc } from '../BrandLogo.jsx';

describe('<BrandLogo>', () => {
  it.each([
    ['horizontal', 'light', '/brand/lodgekeep-logo-horizontal-colour.png'],
    ['horizontal', 'dark', '/brand/lodgekeep-logo-horizontal-white.png'],
    ['mark', 'light', '/brand/lodgekeep-mark-colour.png'],
    ['mark', 'dark', '/brand/lodgekeep-mark-white.png'],
    ['stacked', 'light', '/brand/lodgekeep-logo-colour.png'],
    ['stacked', 'dark', '/brand/lodgekeep-logo-white.png'],
  ])('%s on a %s surface uses %s', (variant, surface, src) => {
    expect(brandLogoSrc(variant, surface)).toBe(src);
    render(<BrandLogo variant={variant} surface={surface} />);
    expect(screen.getByAltText('Lodgekeep')).toHaveAttribute('src', src);
  });

  it('defaults to the colour horizontal lockup (a light surface)', () => {
    render(<BrandLogo />);
    expect(screen.getByAltText('Lodgekeep')).toHaveAttribute('src', '/brand/lodgekeep-logo-horizontal-colour.png');
  });

  it("sets width, height and aspect-ratio from the artwork so nothing shifts on load", () => {
    render(<BrandLogo variant="horizontal" height={40} />);
    const img = screen.getByAltText('Lodgekeep');
    expect(img).toHaveAttribute('height', '40');
    expect(img).toHaveAttribute('width', String(Math.round((40 * 1405) / 339)));
    expect(img.style.aspectRatio).toBe('1405 / 339');
  });
});
