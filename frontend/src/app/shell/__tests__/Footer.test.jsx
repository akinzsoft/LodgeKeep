import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Footer } from '../Footer.jsx';

describe('<Footer>', () => {
  it('shows the -colour LodgeKeep mark (the footer is a light strip)', () => {
    render(<Footer />);
    const logo = screen.getByAltText('Lodgekeep');
    expect(logo).toHaveAttribute('src', '/brand/lodgekeep-mark-colour.png');
    expect(logo).toHaveAttribute('width');
    expect(logo).toHaveAttribute('height');
  });

  it('keeps the Powered by Planmsys credit link', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: 'Powered by Planmsys' })).toHaveAttribute('href', 'https://www.planmsys.com');
  });
});
