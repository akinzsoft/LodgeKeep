import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutletTerminalAccountsCard } from '../../pos/OutletTerminalAccountsCard.jsx';

/** The accounts card reused for the hotel's own (front desk) terminal accounts: a different data source, same behaviour. */
const api = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() };
const props = { api, title: 'Front desk terminal accounts', intro: 'Hotel intro text.' };

describe('hotel terminal accounts (the shared accounts card on another source)', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    api.list.mockResolvedValue([{ id: '1', provider: 'gtbank', bank_name: 'GTBank', account_label: 'Desk', account_number: '1234567890', account_number_last4: '7890' }]);
  });

  it('lists from the given source with its own title and intro, last 4 only in the row', async () => {
    render(<OutletTerminalAccountsCard {...props} />);
    expect(await screen.findByText('GTBank · Desk')).toBeInTheDocument();
    expect(screen.getByText('Front desk terminal accounts')).toBeInTheDocument();
    expect(screen.getByText('Hotel intro text.')).toBeInTheDocument();
    expect(screen.getByText('····7890')).toBeInTheDocument();
    expect(screen.queryByText('1234567890')).not.toBeInTheDocument();
  });

  it('adds an account through the given source, not the outlet endpoints', async () => {
    api.create.mockResolvedValue({ id: '2' });
    render(<OutletTerminalAccountsCard {...props} />);
    await screen.findByText('GTBank · Desk');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await userEvent.type(screen.getByLabelText('Account number'), '5550001111');
    await userEvent.type(screen.getByLabelText('Label (optional)'), 'Lobby');
    await userEvent.click(screen.getByRole('button', { name: 'Save account' }));
    expect(api.create).toHaveBeenCalledWith({ provider: '', accountNumber: '5550001111', bankName: '', accountLabel: 'Lobby' });
  });

  it('removes through the given source and shows a server refusal', async () => {
    api.remove.mockRejectedValueOnce(new Error('boom'));
    render(<OutletTerminalAccountsCard {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove GTBank · Desk account' }));
    expect(api.remove).toHaveBeenCalledWith('1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove this account.');
  });
});
