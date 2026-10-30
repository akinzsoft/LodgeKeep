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

  it('links the "Powered by Planmsys" credit to www.planmsys.com', () => {
    render(<Footer />);
    const link = screen.getByRole('link', { name: 'Powered by Planmsys' });
    expect(link).toHaveAttribute('href', 'https://www.planmsys.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
