import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManualPaymentForm } from '../ManualPaymentForm.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ markSubscribed: vi.fn(), recordPayment: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, ...mocks } };
});

async function fill(user) {
  await user.type(screen.getByLabelText(/receipt or transfer reference/i), 'TRF-1001');
  await user.type(screen.getByLabelText(/amount received/i), '50000.00');
  await user.type(screen.getByLabelText(/paid until/i), '2027-03-01');
  await user.type(screen.getByLabelText(/reason/i), 'Transfer confirmed');
}

describe('<ManualPaymentForm>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends the typed payment to mark-subscribed and reports what was queued', async () => {
    mocks.markSubscribed.mockResolvedValue({ paidUntil: '2027-03-01', emails: { queued: 3, alreadySent: 0 } });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<ManualPaymentForm tenantId="7" mode="subscribe" onDone={onDone} />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Mark subscribed' }));
    expect(mocks.markSubscribed).toHaveBeenCalledWith('7', expect.objectContaining({ plan_code: 'standard', method: 'bank_transfer', reference: 'TRF-1001', amount: '50000.00', currency: 'NGN', paid_until: '2027-03-01' }));
    expect(await screen.findByText(/3 e-mail\(s\) queued/)).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
  });

  it('does nothing when the operator cancels the confirmation', async () => {
    window.confirm.mockReturnValue(false);
    const user = userEvent.setup();
    render(<ManualPaymentForm tenantId="7" mode="subscribe" />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Mark subscribed' }));
    expect(mocks.markSubscribed).not.toHaveBeenCalled();
  });

  it('shows the server refusal', async () => {
    mocks.recordPayment.mockRejectedValue(new ApiError({ status: 409, code: 'BUSINESS_RULE_REFERENCE_ALREADY_USED', message: 'That payment reference has already been recorded.' }));
    const user = userEvent.setup();
    render(<ManualPaymentForm tenantId="7" mode="renew" />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already been recorded');
  });
});
