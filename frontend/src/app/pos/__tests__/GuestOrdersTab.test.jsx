import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuestOrdersTab } from '../GuestOrdersTab.jsx';

const mocks = vi.hoisted(() => ({
  listGuestOrders: vi.fn(),
  listMenuItems: vi.fn(),
  getOrder: vi.fn(),
  acceptGuestOrder: vi.fn(),
  markGuestOrderOnTheWay: vi.fn(),
  rejectGuestOrder: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: {
      listGuestOrders: mocks.listGuestOrders,
      listMenuItems: mocks.listMenuItems,
      getOrder: mocks.getOrder,
      acceptGuestOrder: mocks.acceptGuestOrder,
      markGuestOrderOnTheWay: mocks.markGuestOrderOnTheWay,
      rejectGuestOrder: mocks.rejectGuestOrder,
    },
  };
});

const MENU_ITEMS = [{ id: '10', name: 'Chapman' }];

function orderRow(overrides) {
  return {
    id: '5',
    pos_order_id: '55',
    table_label: 'Table 3',
    guest_name: 'Jordan',
    guest_contact: 'jordan@example.com',
    status: 'received',
    payment_status: 'paid',
    ...overrides,
  };
}

describe('<GuestOrdersTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listMenuItems.mockResolvedValue(MENU_ITEMS);
    mocks.getOrder.mockResolvedValue({ items: [{ menu_item_id: '10', quantity: 2, unit_price: '20.00', voided_at: null }] });
  });

  it('shows a real guest order row with its real items, subtotal, and status/payment pills', async () => {
    mocks.listGuestOrders.mockResolvedValue([orderRow()]);
    render(<GuestOrdersTab />);

    expect(await screen.findByText('Table 3')).toBeInTheDocument();
    expect(screen.getByText('Jordan')).toBeInTheDocument();
    expect(screen.getByText('2× Chapman')).toBeInTheDocument();
    expect(screen.getByText(/40\.00/)).toBeInTheDocument();
    // "Received"/"Preparing"/"On the way"/"Rejected" also appear as options
    // in the status-filter dropdown above the table — scoped to the table
    // itself so these assertions target the real status pill, not the filter.
    expect(within(screen.getByRole('table')).getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('shows a real backend error when the queue fails to load', async () => {
    mocks.listGuestOrders.mockRejectedValue(new Error('boom'));
    render(<GuestOrdersTab />);
    expect(await screen.findByText('Could not load guest orders.')).toBeInTheDocument();
  });

  it('accepts a received order for real', async () => {
    mocks.listGuestOrders.mockResolvedValue([orderRow()]);
    mocks.acceptGuestOrder.mockResolvedValue({});
    render(<GuestOrdersTab />);

    await screen.findByText('Table 3');
    mocks.listGuestOrders.mockResolvedValue([orderRow({ status: 'preparing' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(mocks.acceptGuestOrder).toHaveBeenCalledWith('5');
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Preparing')).toBeInTheDocument());
  });

  it('marks a preparing order on the way for real', async () => {
    mocks.listGuestOrders.mockResolvedValue([orderRow({ status: 'preparing' })]);
    mocks.markGuestOrderOnTheWay.mockResolvedValue({});
    render(<GuestOrdersTab />);

    await screen.findByText('Table 3');
    mocks.listGuestOrders.mockResolvedValue([orderRow({ status: 'on_the_way' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Mark on the way' }));

    expect(mocks.markGuestOrderOnTheWay).toHaveBeenCalledWith('5');
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('On the way')).toBeInTheDocument());
  });

  it('rejecting requires going through the ConfirmDialog with a real reason — no reason, no reject call', async () => {
    mocks.listGuestOrders.mockResolvedValue([orderRow()]);
    render(<GuestOrdersTab />);
    await screen.findByText('Table 3');

    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Any payment already taken');

    const confirmButton = screen.getByRole('button', { name: 'Reject order' });
    expect(confirmButton).toBeDisabled();
    expect(mocks.rejectGuestOrder).not.toHaveBeenCalled();
  });

  it('reject with a real reason calls the real endpoint and reverses payment', async () => {
    mocks.listGuestOrders.mockResolvedValue([orderRow()]);
    mocks.rejectGuestOrder.mockResolvedValue({});
    render(<GuestOrdersTab />);
    await screen.findByText('Table 3');

    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await userEvent.type(screen.getByRole('textbox'), 'Kitchen closed');

    mocks.listGuestOrders.mockResolvedValue([orderRow({ status: 'rejected', payment_status: 'refunded' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Reject order' }));

    expect(mocks.rejectGuestOrder).toHaveBeenCalledWith('5', 'Kitchen closed');
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Rejected')).toBeInTheDocument());
    expect(screen.getByText('Refunded')).toBeInTheDocument();
  });

  it('shows no accept/mark/reject actions for a terminal order', async () => {
    mocks.listGuestOrders.mockResolvedValue([orderRow({ status: 'auto_rejected', payment_status: 'refunded' })]);
    render(<GuestOrdersTab />);
    await screen.findByText('Table 3');
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('filtering by status calls the real endpoint with the chosen filter', async () => {
    mocks.listGuestOrders.mockResolvedValue([]);
    render(<GuestOrdersTab />);
    await waitFor(() => expect(mocks.listGuestOrders).toHaveBeenCalledWith({ status: undefined }));

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'preparing');
    await waitFor(() => expect(mocks.listGuestOrders).toHaveBeenCalledWith({ status: 'preparing' }));
  });
});
