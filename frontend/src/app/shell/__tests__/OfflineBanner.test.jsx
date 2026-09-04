import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OfflineBanner } from '../OfflineBanner.jsx';

describe('<OfflineBanner>', () => {
  it('states that the connection is down (DESIGN_SYSTEM.md §2)', () => {
    render(<OfflineBanner />);
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });

  it('announces as an alert, matching ImpersonationBanner’s "impossible to miss" treatment', () => {
    render(<OfflineBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers no dismiss control — connectivity, not the warning, decides when it goes away', () => {
    render(<OfflineBanner />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
