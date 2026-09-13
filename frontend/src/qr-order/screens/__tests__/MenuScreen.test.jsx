import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
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
    { id: '10', name: 'Chapman', category: 'Drinks', price: '20.00', is_available: true, image_url: '/api/v1/media/menu-items/chapman.png' },
    { id: '11', name: 'Suya', category: 'Snacks', price: '15.00', is_available: true },
    { id: '12', name: 'Zobo', category: 'Drinks', price: '0.10', is_available: true },
  ],
};

const STORAGE_KEY = `lodgekeep.qr-cart.${TOKEN}`;

function CheckoutStub() {
  return <pre data-testid="checkout-state">{JSON.stringify(useLocation().state)}</pre>;
}

function renderScreen() {
  return renderQrOrderScreen({ element: <MenuScreen />, routePath: 'menu', otherRoutes: [{ path: 'checkout', element: <CheckoutStub /> }] });
}

function card(name) {
  return screen.getByRole('heading', { name }).closest('li');
}

describe('<MenuScreen>', () => {
  beforeEach(() => {
    mocks.getMenu.mockReset();
    mocks.getMenu.mockResolvedValue(MENU);
    window.sessionStorage.clear();
  });

  it('shows the outlet and every item as a shop card with its photo, category and price', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Poolside Bar' })).toBeInTheDocument();
    expect(mocks.getMenu).toHaveBeenCalledWith(TOKEN);
    const items = within(screen.getByRole('list', { name: 'Menu items' })).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(card('Chapman')).getByText(/20\.00/)).toBeInTheDocument();
    expect(within(card('Chapman')).getByText('Drinks')).toBeInTheDocument();
    // A photo where one exists, a letter placeholder where it does not.
    expect(card('Chapman').querySelector('img')).toHaveAttribute('src', '/api/v1/media/menu-items/chapman.png');
    expect(card('Suya').querySelector('img')).toBeNull();
  });

  it('shows a load error', async () => {
    mocks.getMenu.mockRejectedValue(new Error('boom'));
    renderScreen();
    expect(await screen.findByText('Could not load the menu.')).toBeInTheDocument();
  });

  it('shows an empty state when the outlet has nothing available', async () => {
    mocks.getMenu.mockResolvedValue({ outlet: { id: '1', name: 'Empty Bar', type: 'bar' }, items: [] });
    renderScreen();
    expect(await screen.findByText('Nothing is available to order right now.')).toBeInTheDocument();
  });

  it('filters by category chip and by search', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Chapman' });

    await userEvent.click(screen.getByRole('button', { name: 'Snacks' }));
    expect(screen.getByRole('button', { name: 'Snacks' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('heading', { name: 'Chapman' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Suya' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the menu' }), 'zob');
    expect(screen.getByRole('heading', { name: 'Zobo' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Suya' })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search the menu' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the menu' }), 'pizza');
    expect(screen.getByText('No items match your search.')).toBeInTheDocument();
  });

  it('turns "Add to cart" into a stepper and keeps an exact money total in the cart bar', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Chapman' });
    expect(screen.queryByRole('button', { name: 'View cart' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add Chapman to cart' }));
    expect(screen.queryByRole('button', { name: 'Add Chapman to cart' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add one Chapman' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Suya to cart' }));
    for (let i = 0; i < 3; i += 1) {
      await userEvent.click(i === 0 ? screen.getByRole('button', { name: 'Add Zobo to cart' }) : screen.getByRole('button', { name: 'Add one Zobo' }));
    }

    // 2 × 20.00 + 15.00 + 3 × 0.10 = 55.30 exactly (0.1 × 3 in floats is 0.30000000000000004).
    const bar = screen.getByRole('button', { name: /View cart/ });
    expect(within(bar).getByText('6 items')).toBeInTheDocument();
    expect(within(bar).getByText(/55\.30/)).toBeInTheDocument();
    expect(within(card('Chapman')).getByText('2 in cart')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cart, 6 items' })).toBeInTheDocument();

    // Stepping back to zero restores the Add button.
    await userEvent.click(screen.getByRole('button', { name: 'Remove one Suya' }));
    expect(screen.getByRole('button', { name: 'Add Suya to cart' })).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /View cart/ })).getByText(/40\.30/)).toBeInTheDocument();
  });

  it('opens the cart sheet to change quantities, remove lines, and empty the cart', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Chapman' });
    await userEvent.click(screen.getByRole('button', { name: 'Add Chapman to cart' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Suya to cart' }));

    await userEvent.click(screen.getByRole('button', { name: /View cart/ }));
    const sheet = screen.getByRole('dialog', { name: /Your cart/ });
    expect(within(sheet).getByText('Your cart · 2 items')).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Add one Chapman' }));
    expect(within(sheet).getByText(/40\.00/)).toBeInTheDocument(); // Chapman line total
    expect(within(sheet).getByText(/55\.00/)).toBeInTheDocument(); // subtotal

    await userEvent.click(within(sheet).getByRole('button', { name: 'Remove Suya from cart' }));
    expect(within(sheet).queryByText('Suya')).not.toBeInTheDocument();
    expect(within(sheet).getByText('Your cart · 2 items')).toBeInTheDocument();

    // Escape closes; the bar comes back.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /View cart/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Empty cart' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View cart/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Chapman to cart' })).toBeInTheDocument();
  });

  it('proceeds to checkout from the cart with every line and the chosen payment method', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Chapman' });
    await userEvent.click(screen.getByRole('button', { name: 'Add Chapman to cart' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add one Chapman' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Suya to cart' }));

    await userEvent.click(screen.getByRole('button', { name: /View cart/ }));
    await userEvent.click(screen.getByLabelText('Charge to my room'));
    await userEvent.click(screen.getByRole('button', { name: 'Proceed to checkout' }));

    const state = JSON.parse((await screen.findByTestId('checkout-state')).textContent);
    expect(state).toEqual({
      paymentMethod: 'room_charge',
      cart: [
        { menuItemId: '10', quantity: 2, name: 'Chapman', price: '20.00' },
        { menuItemId: '11', quantity: 1, name: 'Suya', price: '15.00' },
      ],
    });
  });

  it('remembers the cart for this QR code across a reload, dropping items no longer on the menu', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ 10: 3, 99: 2, 11: -1 }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Chapman' });

    const bar = screen.getByRole('button', { name: /View cart/ });
    expect(within(bar).getByText('3 items')).toBeInTheDocument();
    expect(within(bar).getByText(/60\.00/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add Suya to cart' }));
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY))).toMatchObject({ 10: 3, 11: 1 }));
  });

  it('still works when storage is unavailable', async () => {
    const getItem = vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderScreen();
      await screen.findByRole('heading', { name: 'Chapman' });
      await userEvent.click(screen.getByRole('button', { name: 'Add Chapman to cart' }));
      expect(within(screen.getByRole('button', { name: /View cart/ })).getByText('1 item')).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
