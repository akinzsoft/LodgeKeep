import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { IconBadge } from '../IconBadge.jsx';

describe('<IconBadge>', () => {
  it.each(['booking', 'rooms', 'guest', 'money'])('renders the %s domain tint/accent pairing', (domain) => {
    const { container } = render(
      <IconBadge domain={domain}>
        <svg data-testid="icon" />
      </IconBadge>
    );
    expect(container.firstChild.className).toContain(domain);
  });

  it('renders whatever icon element the caller supplies, without bundling an icon library', () => {
    const { getByTestId } = render(
      <IconBadge domain="money">
        <svg data-testid="custom-icon" />
      </IconBadge>
    );
    expect(getByTestId('custom-icon')).toBeInTheDocument();
  });

  it('is hidden from assistive tech, since it is meant to sit beside a real text label', () => {
    const { container } = render(<IconBadge domain="rooms">*</IconBadge>);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});
