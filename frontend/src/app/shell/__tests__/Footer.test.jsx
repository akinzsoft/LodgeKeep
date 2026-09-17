import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Footer } from '../Footer.jsx';

describe('<Footer>', () => {
  it('shows the "Powered by Planmsys" credit with the platform mark', () => {
    render(<Footer />);
    expect(screen.getByText('Powered by Planmsys')).toBeInTheDocument();
    const icon = document.querySelector('img');
    expect(icon).toBeInTheDocument();
  });

  it('links the credit to www.planmsys.com', () => {
    render(<Footer />);
    const link = screen.getByRole('link', { name: 'Powered by Planmsys' });
    expect(link).toHaveAttribute('href', 'https://www.planmsys.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
