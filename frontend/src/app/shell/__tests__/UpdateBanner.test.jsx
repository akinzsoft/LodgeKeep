import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from '../UpdateBanner.jsx';

describe('<UpdateBanner>', () => {
  it('says a new version is available and offers Reload now or Later', async () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateBanner onReload={onReload} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toHaveTextContent('A new version of LodgeKeep is available.');
    await userEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
