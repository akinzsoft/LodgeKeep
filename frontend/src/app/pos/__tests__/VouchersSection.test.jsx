import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VouchersSection } from '../VouchersSection.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ listVouchers: vi.fn(), createVoucher: vi.fn(), disableVoucher: vi.fn(), enableVoucher: vi.fn(), updateVoucher: vi.fn(), deleteVoucher: vi.fn(), listOutlets: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, discountsApi: mocks, posApi: { listOutlets: mocks.listOutlets } };
});

const ACTIVE = { money_locked: false, id: '1', code: 'ABCD-EFGH-JKLM', type: 'percent', value: '10.00', max_amount: null, check_percent_cap: '25.00', valid_from: '2027-08-01', valid_to: '2027-12-31', max_total_uses: 5, used_count: 2, status: 'active', note: null, outlet_ids: ['7'] };
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
  describe('edit', () => {
    const USED = { ...ACTIVE, id: '9', code: 'USED-CODE-2345', max_amount: '50.00', max_total_uses: 5, used_count: 3, money_locked: true };

    it('opens the create fields pre-filled, with the code shown and Save disabled until something changes', async () => {
      render(<VouchersSection currencyCode="NGN" />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const form = screen.getByRole('form', { name: 'Edit voucher ABCD-EFGH-JKLM' });
      expect(within(form).getByLabelText('Percent')).toHaveValue('10.00');
      expect(within(form).getByLabelText('Valid until')).toHaveValue('2027-12-31');
      expect(within(form).getByLabelText('Main Bar')).toBeChecked();
      expect(within(form).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('sends only what changed and closes the form', async () => {
      mocks.updateVoucher.mockResolvedValue({});
      render(<VouchersSection currencyCode="NGN" />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const form = screen.getByRole('form', { name: 'Edit voucher ABCD-EFGH-JKLM' });
      await userEvent.clear(within(form).getByLabelText('Percent'));
      await userEvent.type(within(form).getByLabelText('Percent'), '12');
      await userEvent.type(within(form).getByLabelText('Note (optional)'), 'Summer');
      await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      expect(mocks.updateVoucher).toHaveBeenCalledWith('1', { value: '12', note: 'Summer' });
      expect(screen.queryByRole('form', { name: /Edit voucher/ })).not.toBeInTheDocument();
    });

    it('Cancel closes it without saving', async () => {
      render(<VouchersSection currencyCode="NGN" />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('form', { name: /Edit voucher/ })).not.toBeInTheDocument();
      expect(mocks.updateVoucher).not.toHaveBeenCalled();
    });

    it('a used voucher has its type, amount and start date locked, says why, and cannot lower uses or the cap', async () => {
      mocks.listVouchers.mockResolvedValue([USED]);
      render(<VouchersSection currencyCode="NGN" />);
      const row = (await screen.findByText('USED-CODE-2345')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const form = screen.getByRole('form', { name: 'Edit voucher USED-CODE-2345' });
      expect(within(form).getByRole('note')).toHaveTextContent(/has been used/);
      expect(within(form).getByLabelText('Percent')).toBeDisabled();
      expect(within(form).getByLabelText('Type')).toBeDisabled();
      expect(within(form).getByLabelText('Valid from')).toBeDisabled();
      expect(within(form).getByLabelText('Valid until')).toBeEnabled();
      const uses = within(form).getByLabelText('Uses in total (optional)');
      await userEvent.clear(uses);
      await userEvent.type(uses, '2');
      expect(within(form).getByRole('button', { name: 'Save changes' })).toBeDisabled(); // below the 3 already used
      await userEvent.clear(uses);
      await userEvent.type(uses, '3');
      expect(within(form).getByRole('button', { name: 'Save changes' })).toBeEnabled();
      const cap = within(form).getByLabelText('Most it takes off (optional)');
      await userEvent.clear(cap);
      await userEvent.type(cap, '20');
      expect(within(form).getByRole('button', { name: 'Save changes' })).toBeDisabled(); // cap lowered
    });

    it('shows the server\'s refusal inside the form and keeps it open', async () => {
      mocks.updateVoucher.mockRejectedValue(new ApiError({ code: 'CONFLICT_VOUCHER_LOCKED', message: 'This voucher has already been used, so value cannot be changed.' }));
      render(<VouchersSection currencyCode="NGN" />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const form = screen.getByRole('form', { name: 'Edit voucher ABCD-EFGH-JKLM' });
      await userEvent.type(within(form).getByLabelText('Note (optional)'), 'x');
      await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      expect(await within(form).findByRole('alert')).toHaveTextContent('already been used');
      expect(screen.getByRole('form', { name: 'Edit voucher ABCD-EFGH-JKLM' })).toBeInTheDocument();
    });

    it('is disabled while offline', async () => {
      render(<VouchersSection currencyCode="NGN" isOffline />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      expect(within(row).getByRole('button', { name: 'Edit' })).toBeDisabled();
    });
  });

  describe('delete', () => {
    it('is hidden for anyone but a super admin', async () => {
      render(<VouchersSection currencyCode="NGN" />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      expect(within(row).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('asks first, then deletes and reloads', async () => {
      mocks.deleteVoucher.mockResolvedValue({ id: '1', deleted: true });
      render(<VouchersSection currencyCode="NGN" canDelete />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(mocks.deleteVoucher).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(mocks.deleteVoucher).toHaveBeenCalledWith('1');
      expect(mocks.listVouchers).toHaveBeenCalledTimes(2);
    });

    it('shows the "Disable it instead" refusal when the voucher has history', async () => {
      mocks.deleteVoucher.mockRejectedValue(new ApiError({ code: 'CONFLICT_VOUCHER_HAS_HISTORY', message: 'This voucher has been put on a check, so it cannot be deleted. Disable it instead.' }));
      render(<VouchersSection currencyCode="NGN" canDelete />);
      const row = (await screen.findByText('ABCD-EFGH-JKLM')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Disable it instead');
    });
  });
});
