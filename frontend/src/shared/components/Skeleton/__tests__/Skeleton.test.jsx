import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton } from '../Skeleton.jsx';

describe('<Skeleton>', () => {
  it('renders at the given real dimensions rather than a spinner (DESIGN_SYSTEM.md §2)', () => {
    const { container } = render(<Skeleton width="120px" height="20px" />);
    const el = container.firstChild;
    expect(el.style.width).toBe('120px');
    expect(el.style.height).toBe('20px');
  });

  it('is hidden from assistive tech — a placeholder announces nothing useful', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});
