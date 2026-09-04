import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Footer } from '../Footer.jsx';

describe('<Footer>', () => {
  it('shows the "Powered by LodgeKeep" credit with the platform mark', () => {
    render(<Footer />);
    expect(screen.getByText('Powered by LodgeKeep')).toBeInTheDocument();
    const icon = document.querySelector('img');
    expect(icon).toBeInTheDocument();
  });
});
