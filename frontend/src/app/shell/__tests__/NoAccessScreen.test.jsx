import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoAccessScreen } from '../NoAccessScreen.jsx';

describe('<NoAccessScreen>', () => {
  it('states plainly that access is missing, as an alert', () => {
    render(<NoAccessScreen onGoHome={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/you don't have access to this/i);
  });

  it('offers a way back to Home', async () => {
    const onGoHome = vi.fn();
    render(<NoAccessScreen onGoHome={onGoHome} />);
    await userEvent.click(screen.getByRole('button', { name: /go to home/i }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });
});
