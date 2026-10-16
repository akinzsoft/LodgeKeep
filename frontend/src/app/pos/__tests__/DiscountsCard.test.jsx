import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiscountsCard, isValidLimit } from '../DiscountsCard.jsx';

const mocks = vi.hoisted(() => ({ listReasons: vi.fn(), listLimits: vi.fn(), createReason: vi.fn(), updateReason: vi.fn(), setLimit: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, discountsApi: mocks };
});

const REASONS = [
  { id: '1', code: 'promo', name: 'Promotion', kind: 'discount', status: 'active' },
  { id: '2', code: 'old', name: 'Old reason', kind: 'both', status: 'archived' },
];
const LIMITS = [
  { role: 'pos_operator', max_percent: '5.00', is_default: true },
  { role: 'manager', max_percent: '25.00', is_default: true },
  { role: 'admin', max_percent: '50.00', is_default: true },
  { role: 'super_admin', max_percent: '100.00', is_default: true },
];

describe('isValidLimit', () => {
  it('accepts 0 to 100 with at most 2 decimals', () => {
    for (const ok of ['0', '5', '12.5', '100', '99.99']) expect(isValidLimit(ok)).toBe(true);
    for (const bad of ['', '-1', '100.01', '1e2', '5.555', 'abc']) expect(isValidLimit(bad)).toBe(false);
  });
});

describe('<DiscountsCard>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listReasons.mockResolvedValue(REASONS);
    mocks.listLimits.mockResolvedValue(LIMITS);
  });

  it("lists the reasons and each role's limit", async () => {
    render(<DiscountsCard />);
    expect(await screen.findByText('Promotion')).toBeInTheDocument();
    expect(screen.getByText('Old reason')).toBeInTheDocument();
    expect(screen.getByLabelText('Limit for Cashier / POS operator (%)')).toHaveValue('5.00');
    expect(screen.getByLabelText('Limit for Super admin (%)')).toHaveValue('100.00');
    expect(mocks.listReasons).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('adds a reason', async () => {
    mocks.createReason.mockResolvedValue({});
    render(<DiscountsCard />);
    await screen.findByText('Promotion');
    await userEvent.type(screen.getByLabelText('Name'), 'VIP guest');
    await userEvent.type(screen.getByLabelText('Code'), 'vip');
    await userEvent.selectOptions(screen.getByLabelText('For'), 'discount');
    await userEvent.click(screen.getByRole('button', { name: 'Add reason' }));
    expect(mocks.createReason).toHaveBeenCalledWith({ code: 'vip', name: 'VIP guest', kind: 'discount' });
  });

  it('archives an active reason and restores an archived one', async () => {
    mocks.updateReason.mockResolvedValue({});
    render(<DiscountsCard />);
    await screen.findByText('Promotion');
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(mocks.updateReason).toHaveBeenCalledWith('1', { status: 'archived' });
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(mocks.updateReason).toHaveBeenCalledWith('2', { status: 'active' });
  });

  it('saves a changed limit only when it is valid and different', async () => {
    mocks.setLimit.mockResolvedValue({});
    render(<DiscountsCard />);
    await screen.findByText('Promotion');
    const field = screen.getByLabelText('Limit for Manager (%)');
    const row = field.closest('li');
    const save = within(row).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, '120');
    expect(save).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, '30');
    await userEvent.click(save);
    expect(mocks.setLimit).toHaveBeenCalledWith('manager', '30');
  });

  it('is read-only without the manage permission', async () => {
    render(<DiscountsCard canManage={false} />);
    await screen.findByText('Promotion');
    expect(screen.queryByRole('button', { name: 'Add reason' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Limit for Manager (%)')).not.toBeInTheDocument();
    expect(screen.getByText('25.00%')).toBeInTheDocument();
    expect(mocks.listReasons).toHaveBeenCalledWith({ includeArchived: false });
  });

  it('disables changes while offline', async () => {
    render(<DiscountsCard isOffline />);
    await screen.findByText('Promotion');
    expect(screen.getByRole('button', { name: 'Add reason' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
  });
});
