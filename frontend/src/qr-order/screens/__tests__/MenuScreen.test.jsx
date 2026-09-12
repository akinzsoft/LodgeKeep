import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MenuScreen } from '../MenuScreen.jsx';
import { renderQrOrderScreen, TOKEN } from './renderQrOrderScreen.jsx';

const mocks = vi.hoisted(() => ({ getMenu: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, qrOrderingApi: { getMenu: mocks.getMenu } };
});

const MENU = {
  outlet: { id: '1', name: 'Poolside Bar', type: 'bar' },
  items: [
    { id: '10', name: 'Chapman', category: 'Drinks', price: '20.00', is_available: true },
    { id: '11', name: 'Suya', category: 'Snacks', price: '15.00', is_available: true },
  ],
};

function CheckoutStub() {
  return null;
}

function renderScreen(otherRoutes) {
  return renderQrOrderScreen({ element: <MenuScreen />, routePath: 'menu', otherRoutes });
}

describe('<MenuScreen>', () => {
  beforeEach(() => {
    mocks.getMenu.mockReset();
  });

  it('shows the real outlet name and menu items grouped by category, with real money', async () => {
    mocks.getMenu.mockResolvedValue(MENU);
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Poolside Bar' })).toBeInTheDocument();
    expect(screen.getByText('Drinks')).toBeInTheDocument();
    expect(screen.getByText('Snacks')).toBeInTheDocument();
    expect(screen.getByText('Chapman')).toBeInTheDocument();
    expect(screen.getByText('Suya')).toBeInTheDocument();
    expect(mocks.getMenu).toHaveBeenCalledWith(TOKEN);
  });

  it('shows a real backend error when the menu fails to load', async () => {
    mocks.getMenu.mockRejectedValue(new Error('boom'));
    renderScreen();
    expect(await screen.findByText('Could not load the menu.')).toBeInTheDocument();
  });

  it('shows an empty state when the outlet has nothing available', async () => {
    mocks.getMenu.mockResolvedValue({ outlet: { id: '1', name: 'Empty Bar', type: 'bar' }, items: [] });
    renderScreen();
    expect(await screen.findByText('Nothing is available to order right now.')).toBeInTheDocument();
  });

  it('builds a cart and computes an exact money total, never a float approximation', async () => {
    mocks.getMenu.mockResolvedValue(MENU);
    renderScreen();
    await screen.findByText('Chapman');

    await userEvent.click(screen.getByRole('button', { name: 'Add one Chapman' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add one Chapman' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add one Suya' }));

    // 2 x 20.00 + 1 x 15.00 = 55.00 exactly.
    expect(await screen.findByText(/55\.00/)).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();

    // Removing one Chapman brings the total back down exactly.
    await userEvent.click(screen.getByRole('button', { name: 'Remove one Chapman' }));
    expect(await screen.findByText(/35\.00/)).toBeInTheDocument();
  });

  it('proceeds to checkout carrying the real cart and chosen payment method', async () => {
    mocks.getMenu.mockResolvedValue(MENU);
    renderScreen([{ path: 'checkout', element: <CheckoutStub /> }]);
    await screen.findByText('Chapman');

    await userEvent.click(screen.getByRole('button', { name: 'Add one Chapman' }));
    await userEvent.click(screen.getByLabelText('Charge to my room'));
    await userEvent.click(screen.getByRole('button', { name: 'Proceed to checkout' }));

    // Navigation to the sibling route succeeded — the cart bar (menu-only UI) is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Proceed to checkout' })).not.toBeInTheDocument());
  });

  it('does not show the cart bar with an empty cart', async () => {
    mocks.getMenu.mockResolvedValue(MENU);
    renderScreen();
    await screen.findByText('Chapman');
    expect(screen.queryByRole('button', { name: 'Proceed to checkout' })).not.toBeInTheDocument();
  });
});
