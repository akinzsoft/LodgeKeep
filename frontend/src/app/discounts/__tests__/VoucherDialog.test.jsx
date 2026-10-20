import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoucherDialog, voucherAppliedText } from '../VoucherDialog.jsx';
import { ApiError } from '../../../shared/api/index.js';

describe('<VoucherDialog>', () => {
  it('sends the code exactly as typed and reports the result', async () => {
    const apply = vi.fn().mockResolvedValue({ id: '1', amount: '20.00' });
    const onDone = vi.fn();
    render(<VoucherDialog apply={apply} onDone={onDone} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText('Voucher code'), 'abcd-efgh jklm');
    await userEvent.click(screen.getByRole('button', { name: 'Use voucher' }));
    expect(apply).toHaveBeenCalledWith('abcd-efgh jklm');
    expect(onDone).toHaveBeenCalledWith({ id: '1', amount: '20.00' });
  });

  it('will not submit a code that is too short to be one', async () => {
    render(<VoucherDialog apply={vi.fn()} onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Use voucher' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Voucher code'), 'AB-CD');
    expect(screen.getByRole('button', { name: 'Use voucher' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Voucher code'), 'EFGHJ');
    expect(screen.getByRole('button', { name: 'Use voucher' })).toBeEnabled();
  });

  it('shows the server\'s message and stays open when the voucher cannot be used', async () => {
    const apply = vi.fn().mockRejectedValue(new ApiError({ code: 'BUSINESS_RULE_VOUCHER_INVALID', message: 'That voucher code cannot be used here.' }));
    const onDone = vi.fn();
    render(<VoucherDialog apply={apply} onDone={onDone} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText('Voucher code'), 'NOSUCHCODE12');
    await userEvent.click(screen.getByRole('button', { name: 'Use voucher' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That voucher code cannot be used here.');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('says so, and cannot submit, while offline', async () => {
    render(<VoucherDialog apply={vi.fn()} onDone={() => {}} onCancel={() => {}} isOffline />);
    await userEvent.type(screen.getByLabelText('Voucher code'), 'ABCDEFGHJKLM');
    expect(screen.getByRole('button', { name: 'Use voucher' })).toBeDisabled();
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });

  it('cancels with Escape and with the button', async () => {
    const onCancel = vi.fn();
    render(<VoucherDialog apply={vi.fn()} onDone={() => {}} onCancel={onCancel} />);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('words the toast with the amount', () => {
    expect(voucherAppliedText({ amount: '20.00' }, 'NGN')).toMatch(/Voucher applied: .*20\.00.* off\./);
    expect(voucherAppliedText({}, 'NGN')).toBe('Voucher applied.');
  });
});
