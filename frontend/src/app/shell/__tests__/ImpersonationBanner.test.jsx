import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImpersonationBanner } from '../ImpersonationBanner.jsx';

describe('<ImpersonationBanner>', () => {
  it('states whose account is being viewed', () => {
    render(<ImpersonationBanner tenantName="Alpha Hotels" onExit={() => {}} />);
    expect(screen.getByText(/Alpha Hotels/)).toBeInTheDocument();
  });

  it('announces as an alert, so it cannot be missed by assistive tech either', () => {
    render(<ImpersonationBanner tenantName="Alpha Hotels" onExit={() => {}} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers only an exit action — no dismiss control exists', () => {
    render(<ImpersonationBanner tenantName="Alpha Hotels" onExit={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Exit impersonation');
  });

  it('calls onExit, which ends the impersonation grant — not a local dismiss', async () => {
    const onExit = vi.fn();
    render(<ImpersonationBanner tenantName="Alpha Hotels" onExit={onExit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));
    expect(onExit).toHaveBeenCalled();
  });
});
