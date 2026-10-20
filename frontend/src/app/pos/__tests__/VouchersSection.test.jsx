import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VouchersSection } from '../VouchersSection.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ listVouchers: vi.fn(), createVoucher: vi.fn(), disableVoucher: vi.fn(), enableVoucher: vi.fn(), listOutlets: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, discountsApi: mocks, posApi: { listOutlets: mocks.listOutlets } };
});

const ACTIVE = { id: '1', code: 'ABCD-EFGH-JKLM', type: 'percent', value: '10.00', max_amount: null, check_percent_cap: '25.00', valid_from: '2027-08-01', valid_to: '2027-12-31', max_total_uses: 5, used_count: 2, status: 'active', note: null, outlet_ids: ['7'] };
const OFF = { ...ACTIVE, id: '2', code: 'WXYZ-2345-6789', type: 'fixed', value: '500.00', max_amount: '500.00', max_total_uses: null, used_count: 0, status: 'disabled', outlet_ids: [] };

describe('<VouchersSection>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listVouchers.mockResolvedValue([ACTIVE, OFF]);
    mocks.listOutlets.mockResolvedValue([{ id: '7', name: 'Main Bar' }, { id: '8', name: 'Pool Bar' }]);
  });

  it('lists each voucher with its code, worth, uses, dates, outlets and state', async () => {
    render(<VouchersSection currencyCode="NGN" />);
    const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
    expect(row).toHaveTextContent('10%');
    expect(row).toHaveTextContent('2 of 5 used');
    expect(row).toHaveTextContent('2027-08-01 to 2027-12-31');
    expect(row).toHaveTextContent('Main Bar');
    expect(row).toHaveTextContent('Active');
    const off = screen.getByText('WXYZ-2345-6789').closest('tr');
    expect(off).toHaveTextContent('0 used');
    expect(off).toHaveTextContent('All outlets');
    expect(off).toHaveTextContent('Disabled');
  });

  it('creates a voucher with only what was typed (the server makes the code) and shows the new code', async () => {
    mocks.createVoucher.mockResolvedValue({ ...ACTIVE, id: '3', code: 'NEW1-CODE-2345' });
    render(<VouchersSection currencyCode="NGN" />);
    await screen.findByText('ABCD-EFGH-JKLM');
    await userEvent.type(screen.getByLabelText('Percent'), '15');
    await userEvent.type(screen.getByLabelText('Valid until'), '2027-12-31');
    await userEvent.type(screen.getByLabelText('Uses in total (optional)'), '10');
    await userEvent.click(screen.getByLabelText('Pool Bar'));
    await userEvent.click(screen.getByRole('button', { name: 'Create voucher' }));
    expect(mocks.createVoucher).toHaveBeenCalledWith({ type: 'percent', value: '15', validTo: '2027-12-31', validFrom: undefined, maxAmount: undefined, maxTotalUses: 10, outletIds: ['8'], note: undefined, overrideLimit: false });
    expect(await screen.findByText('NEW1-CODE-2345')).toBeInTheDocument();
  });

  it('will not submit a bad value, cap or use count', async () => {
    render(<VouchersSection currencyCode="NGN" />);
    await screen.findByText('ABCD-EFGH-JKLM');
    await userEvent.type(screen.getByLabelText('Valid until'), '2027-12-31');
    const create = screen.getByRole('button', { name: 'Create voucher' });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Percent'), '1e2');
    expect(create).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Percent'));
    await userEvent.type(screen.getByLabelText('Percent'), '10');
    expect(create).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Most it takes off (optional)'), '-5');
    expect(create).toBeDisabled();
  });

  it('sends the override flag only when ticked, and shows the server\'s refusal', async () => {
    mocks.createVoucher.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_VOUCHER_NEEDS_COMP', message: 'A voucher above your discount limit needs comp authority (discount.comp).' }));
    render(<VouchersSection currencyCode="NGN" />);
    await screen.findByText('ABCD-EFGH-JKLM');
    await userEvent.type(screen.getByLabelText('Percent'), '60');
    await userEvent.type(screen.getByLabelText('Valid until'), '2027-12-31');
    await userEvent.click(screen.getByLabelText(/Allow more than my own discount limit/));
    await userEvent.click(screen.getByRole('button', { name: 'Create voucher' }));
    expect(mocks.createVoucher).toHaveBeenCalledWith(expect.objectContaining({ overrideLimit: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs comp authority');
  });

  it('disables a voucher only with a reason, and enables one at once', async () => {
    mocks.disableVoucher.mockResolvedValue({});
    mocks.enableVoucher.mockResolvedValue({});
    render(<VouchersSection currencyCode="NGN" />);
    const activeRow = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
    await userEvent.click(within(activeRow).getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Disable' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/reason/i), 'Printed in error');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(mocks.disableVoucher).toHaveBeenCalledWith('1', 'Printed in error');

    const offRow = screen.getByText('WXYZ-2345-6789').closest('tr');
    await userEvent.click(within(offRow).getByRole('button', { name: 'Enable' }));
    expect(mocks.enableVoucher).toHaveBeenCalledWith('2');
  });

  it('is disabled while offline and says nothing is created from here', async () => {
    render(<VouchersSection currencyCode="NGN" isOffline />);
    await screen.findByText('ABCD-EFGH-JKLM');
    expect(screen.getByRole('button', { name: 'Create voucher' })).toBeDisabled();
    expect(within((await screen.findByText('ABCD-EFGH-JKLM')).closest('tr')).getByRole('button', { name: 'Disable' })).toBeDisabled();
  });

  it('shows an error when the list cannot be loaded', async () => {
    mocks.listVouchers.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Something went wrong.' }));
    render(<VouchersSection currencyCode="NGN" />);
    expect((await screen.findAllByRole('alert')).some((node) => /Something went wrong\./.test(node.textContent))).toBe(true);
  });
});
