import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpScreen } from '../HelpScreen.jsx';

const mocks = vi.hoisted(() => ({
  getSetupProgress: vi.fn(), getPaymentSubaccount: vi.fn(), listOutlets: vi.fn(), listTerminals: vi.fn(), listMenuItems: vi.fn(), listApprovers: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { ...actual.setupApi, getSetupProgress: mocks.getSetupProgress, getPaymentSubaccount: mocks.getPaymentSubaccount },
    posApi: { ...actual.posApi, listOutlets: mocks.listOutlets, listTerminals: mocks.listTerminals, listMenuItems: mocks.listMenuItems },
    approvalsApi: { ...actual.approvalsApi, listApprovers: mocks.listApprovers },
  };
});

const PROPERTY = { id: '1', name: 'Demo' };

beforeEach(() => {
  localStorage.clear();
  mocks.getSetupProgress.mockResolvedValue({ steps: [
    { key: 'property', complete: true }, { key: 'room-types', complete: true }, { key: 'rooms', complete: true },
    { key: 'rate-codes', complete: false }, { key: 'taxes', complete: false }, { key: 'users', complete: false },
  ] });
  mocks.getPaymentSubaccount.mockRejectedValue(new Error('403'));
  mocks.listOutlets.mockResolvedValue([]);
  mocks.listTerminals.mockResolvedValue([]);
  mocks.listMenuItems.mockResolvedValue([]);
  mocks.listApprovers.mockResolvedValue([]);
});

describe('HelpScreen', () => {
  it('ticks steps from existing data and names the next one', async () => {
    render(<HelpScreen activeProperty={PROPERTY} currentUserId="5" />);
    expect(await screen.findByText('1 of 9 steps done')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Property details/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Property details/ })).toBeDisabled();
    expect(screen.getByText(/Next:/)).toHaveTextContent('Room types, rooms and rates');
  });

  it('lets a hand tick cover a step that cannot be checked, and remembers it in this browser', async () => {
    const user = userEvent.setup();
    render(<HelpScreen activeProperty={PROPERTY} currentUserId="5" />);
    await screen.findByText('1 of 9 steps done');
    await user.click(screen.getByRole('checkbox', { name: /Payment methods/ }));
    expect(await screen.findByText('2 of 9 steps done')).toBeInTheDocument();
    expect(Object.values(localStorage).join()).toContain('payments');
  });

  it('opens a step guide with step navigation and a link to its Common problems guide', async () => {
    const user = userEvent.setup();
    render(<HelpScreen activeProperty={PROPERTY} currentUserId="5" />);
    await user.click(await screen.findByRole('button', { name: 'Taxes and service charge' }));
    expect(screen.getByText('Step 3 of 9')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'A tax is missing or wrong' }));
    expect(screen.getByRole('heading', { name: 'A tax is missing or wrong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Back to Help/ }));
    expect(screen.getByRole('heading', { name: 'Help and Training' })).toBeInTheDocument();
  });

  it('lists the screen guides under their work area and opens one', async () => {
    const user = userEvent.setup();
    render(<HelpScreen activeProperty={PROPERTY} currentUserId="5" />);
    expect(await screen.findByRole('heading', { name: 'How to use each screen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Restaurant and bar' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cashiering and money' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Supermarket' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Opening and closing a shift' }));
    expect(screen.getByRole('heading', { name: 'Opening and closing a shift' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Who can do this' })).toBeInTheDocument();
    expect(screen.queryByText(/^Step \d+ of 9$/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'The daily routine' }));
    expect(screen.getByText('Step 8 of 9')).toBeInTheDocument();
  });
});
