import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from '../StatusPill.jsx';

describe('<StatusPill>', () => {
  it('always carries a visible text label, not colour alone (TESTING.md FE-4)', () => {
    render(<StatusPill tone="success" label="Confirmed" />);
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it.each(['success', 'warning', 'danger', 'info', 'neutral'])(
    'renders the %s tone using its token, not a literal colour',
    (tone) => {
      render(<StatusPill tone={tone} label={tone} />);
      const el = screen.getByText(tone);
      expect(el.className).toContain(tone);
    }
  );

  it('throws rather than rendering a pill with no label', () => {
    expect(() => render(<StatusPill tone="danger" />)).toThrow(/requires a label/);
  });
});
