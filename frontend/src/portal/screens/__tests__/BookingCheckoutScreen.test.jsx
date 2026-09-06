import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingCheckoutScreen } from '../BookingCheckoutScreen.jsx';
import { renderPortalScreen, PROPERTY_SLUG } from './renderPortalScreen.jsx';

const mocks = vi.hoisted(() => ({
  listRateCodes: vi.fn(),
  createAnonymousBooking: vi.fn(),
  createAccountBooking: vi.fn(),
  retryStartCheckout: vi.fn(),
  getPropertyBranding: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    portalApi: {
      listRateCodes: mocks.listRateCodes,
      createAnonymousBooking: mocks.createAnonymousBooking,
      createAccountBooking: mocks.createAccountBooking,
      retryStartCheckout: mocks.retryStartCheckout,
      getPropertyBranding: mocks.getPropertyBranding,
    },
  };
});

const QUERY = 'room_type_id=1&room_type_name=Deluxe&rate=100.00&arrival_date=2027-01-01&departure_date=2027-01-02&adults=2&children=0';

function renderScreen() {
  return renderPortalScreen({
    element: <BookingCheckoutScreen />,
    routePath: 'book',
    initialPath: `/portal/${PROPERTY_SLUG}/book?${QUERY}`,
  });
}

const locationAssign = vi.fn();

describe('<BookingCheckoutScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPropertyBranding.mockResolvedValue({ name: PROPERTY_SLUG, logoUrl: null, theme: null, baseCurrency: 'NGN' });
    mocks.listRateCodes.mockResolvedValue([{ id: '7', code: 'STD' }]);

    // jsdom's `window.location.assign` is a non-configurable native
    // property — it cannot be `vi.spyOn`'d in place, so the whole
    // `location` object is replaced with a plain, writable stand-in that
    // keeps its real `origin`/`href` (the screen reads `origin` to build
    // callback URLs) alongside a fake, assertable `assign`.
    locationAssign.mockReset();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: locationAssign },
    });
  });

  it('shows the booking summary from the search screen’s own query params', async () => {
    renderScreen();
    expect(await screen.findByText('Deluxe')).toBeInTheDocument();
    expect(screen.getByText('2027-01-01 → 2027-01-02')).toBeInTheDocument();
    expect(screen.getByText('2 adults')).toBeInTheDocument();
  });

  it('books anonymously and redirects the browser to the real Paystack checkout URL', async () => {
    mocks.createAnonymousBooking.mockResolvedValue({
      reservation: { id: '5', confirmation_number: '01BOOK' },
      folio: { id: '9' },
      payment: { id: '3' },
      authorizationUrl: 'https://paystack.test/pay/abc',
    });
    renderScreen();

    await userEvent.type(screen.getByLabelText('First name'), 'Jordan');
    await userEvent.type(screen.getByLabelText('Last name'), 'Ade');
    await userEvent.type(screen.getByLabelText('Email'), 'jordan@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));

    await waitFor(() => expect(locationAssign).toHaveBeenCalledWith('https://paystack.test/pay/abc'));
    expect(mocks.createAnonymousBooking).toHaveBeenCalledWith(
      expect.objectContaining({ propertySlug: PROPERTY_SLUG, roomTypeId: '1', rateCodeId: '7', firstName: 'Jordan', lastName: 'Ade', email: 'jordan@example.com' })
    );
  });

  it('shows a real, actionable error on the honest-202 partial-success path, never a silent drop', async () => {
    mocks.createAnonymousBooking.mockResolvedValue({
      reservation: { id: '5', confirmation_number: '01BOOK' },
      folio: { id: '9' },
      payment: { id: '3' },
      checkoutError: 'Paystack timed out.',
    });
    renderScreen();

    await userEvent.type(screen.getByLabelText('First name'), 'Jordan');
    await userEvent.type(screen.getByLabelText('Last name'), 'Ade');
    await userEvent.type(screen.getByLabelText('Email'), 'jordan@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Paystack timed out.');
    expect(screen.getByText('01BOOK')).toBeInTheDocument();

    mocks.retryStartCheckout.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/retry' });
    await userEvent.click(screen.getByRole('button', { name: 'Retry payment' }));

    expect(mocks.retryStartCheckout).toHaveBeenCalledWith(expect.objectContaining({ propertySlug: PROPERTY_SLUG, confirmationNumber: '01BOOK', email: 'jordan@example.com' }));
    expect(locationAssign).toHaveBeenCalledWith('https://paystack.test/pay/retry');
  });

  it('surfaces a real error when no active rate plan exists, rather than booking against a made-up one', async () => {
    mocks.listRateCodes.mockResolvedValue([]);
    renderScreen();

    await userEvent.type(screen.getByLabelText('First name'), 'Jordan');
    await userEvent.type(screen.getByLabelText('Last name'), 'Ade');
    await userEvent.type(screen.getByLabelText('Email'), 'jordan@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This property has no active rate plans configured yet.');
    expect(mocks.createAnonymousBooking).not.toHaveBeenCalled();
  });

  it('disables submission and explains why when required booking details are missing', async () => {
    renderPortalScreen({ element: <BookingCheckoutScreen />, routePath: 'book', initialPath: `/portal/${PROPERTY_SLUG}/book` });
    expect(await screen.findByRole('alert')).toHaveTextContent('This booking is missing required details');
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
  });
});
