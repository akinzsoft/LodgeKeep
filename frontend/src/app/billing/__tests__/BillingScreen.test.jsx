import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BillingScreen } from '../BillingScreen.jsx';

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  listInvoices: vi.fn(),
  startPaymentMethodCheckout: vi.fn(),
  completePaymentMethod: vi.fn(),
  getOffboardingStatus: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    billingApi: { ...actual.billingApi, getOverview: mocks.getOverview, listInvoices: mocks.listInvoices, startPaymentMethodCheckout: mocks.startPaymentMethodCheckout, completePaymentMethod: mocks.completePaymentMethod },
    offboardingApi: { ...actual.offboardingApi, getOffboardingStatus: mocks.getOffboardingStatus },
  };
});

vi.mock('../../../shared/paystack.js', () => ({
  openPaystackPopup: vi.fn(({ onClose }) => {
    onClose();
    return Promise.resolve();
  }),
}));

const NO_SUBSCRIPTION_OVERVIEW = {
  tenant: { status: 'trial', trial_ends_at: '2027-01-01' },
  plan: { id: '1', code: 'standard', name: 'Standard', price: '50000.00', currency: 'NGN', billing_interval: 'monthly' },
  subscription: null,
};

const ACTIVE_SUBSCRIPTION_OVERVIEW = {
  tenant: { status: 'active', trial_ends_at: null },
  plan: { id: '1', code: 'standard', name: 'Standard', price: '50000.00', currency: 'NGN', billing_interval: 'monthly' },
  subscription: {
    id: '1',
    status: 'active',
    current_period_start: '2027-01-01',
    current_period_end: '2027-02-01',
    consecutive_failed_attempts: 0,
    payment_method: { provider: 'paystack', last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2030 },
  },
};

describe('<BillingScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listInvoices.mockResolvedValue([]);
    mocks.getOffboardingStatus.mockResolvedValue({ status: 'active', offboardingRequestedAt: null, retentionExpiresAt: null, latestExport: null });
  });

  it('shows no active subscription and the default plan when none exists yet', async () => {
    mocks.getOverview.mockResolvedValue(NO_SUBSCRIPTION_OVERVIEW);
    render(<BillingScreen />);
    expect(await screen.findByText(/no active subscription/i)).toBeInTheDocument();
    expect(await screen.findByText(/Standard/)).toBeInTheDocument();
    expect(await screen.findByText(/no payment method on file yet/i)).toBeInTheDocument();
  });

  it('shows the real subscription status, period, and payment method once one exists', async () => {
    mocks.getOverview.mockResolvedValue(ACTIVE_SUBSCRIPTION_OVERVIEW);
    render(<BillingScreen />);
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(await screen.findByText('2027-01-01 – 2027-02-01')).toBeInTheDocument();
    expect(await screen.findByText(/VISA •••• 4242/)).toBeInTheDocument();
  });

  it('surfaces a real backend error without crashing the rest of the screen', async () => {
    mocks.getOverview.mockRejectedValue(new Error('boom'));
    render(<BillingScreen />);
    // Appears three times — the top-level banner plus each Card's own
    // `errorMessage` slot — all showing the same real error text.
    expect((await screen.findAllByText('Could not load billing information.')).length).toBeGreaterThan(0);
  });

  it('starting a checkout then closing the popup completes the payment method and reloads the overview', async () => {
    mocks.getOverview.mockResolvedValueOnce(NO_SUBSCRIPTION_OVERVIEW).mockResolvedValueOnce(ACTIVE_SUBSCRIPTION_OVERVIEW);
    mocks.startPaymentMethodCheckout.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/abc', accessCode: 'access_abc', reference: 'ref_abc' });
    mocks.completePaymentMethod.mockResolvedValue({ id: '1' });

    render(<BillingScreen />);
    await screen.findByText(/add payment method/i);

    await userEvent.type(screen.getByLabelText('Billing email'), 'admin@alpha-hotels.example.com');
    await userEvent.click(screen.getByRole('button', { name: /add payment method/i }));

    await screen.findByRole('button', { name: /verify card now/i });
    await userEvent.click(screen.getByRole('button', { name: /verify card now/i }));

    await waitFor(() => expect(mocks.completePaymentMethod).toHaveBeenCalledWith('ref_abc'));
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('disables the payment-method form while offline', async () => {
    mocks.getOverview.mockResolvedValue(NO_SUBSCRIPTION_OVERVIEW);
    render(<BillingScreen isOffline />);
    expect(await screen.findByText(/you are offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add payment method/i })).toBeDisabled();
  });

  it('lists real invoice history rows', async () => {
    mocks.getOverview.mockResolvedValue(ACTIVE_SUBSCRIPTION_OVERVIEW);
    mocks.listInvoices.mockResolvedValue([
      { id: '1', period_start: '2026-12-01', period_end: '2027-01-01', amount: '50000.00', currency: 'NGN', status: 'paid', due_at: '2026-12-01' },
    ]);
    render(<BillingScreen />);
    expect(await screen.findByText('2026-12-01 – 2027-01-01')).toBeInTheDocument(); // the invoice row's own period, distinct from the subscription's current one
    expect(await screen.findByText('Paid')).toBeInTheDocument();
  });
});
