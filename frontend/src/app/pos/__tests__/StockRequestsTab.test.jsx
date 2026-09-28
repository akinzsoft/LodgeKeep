import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockRequestsTab } from '../StockRequestsTab.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  listTransferRequests: vi.fn(),
  createTransferRequest: vi.fn(),
  issueTransferRequest: vi.fn(),
  rejectTransferRequest: vi.fn(),
  getTransferRequest: vi.fn(),
  getMyRequestOutlets: vi.fn(),
  cancelTransferRequest: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  const { listOutlets, ...stockApi } = mocks;
  return { ...actual, posApi: { listOutlets }, stockApi };
});

const STORE = { id: '1', name: 'Main Store', type: 'store' };
const BAR = { id: '2', name: 'Main Bar', type: 'bar' };
const COKE = { id: '20', name: 'Coke', unit: 'bottle', category: 'Soft drinks', current_quantity: '30.000' };
const GIN = { id: '21', name: 'Gin', unit: 'bottle', category: 'Spirits', current_quantity: '1.000' };

const REQUESTER = new Set(['pos.operate', 'pos.stock_view', 'pos.stock_request']);
const STOREKEEPER = new Set(['pos.stock_view', 'pos.stock_transfer']);

function pendingRequest(overrides = {}) {
  return {
    id: '5',
    status: 'pending',
    note: 'Friday night',
    fromOutlet: { id: '1', name: 'Main Store', type: 'store' },
    toOutlet: { id: '2', name: 'Main Bar' },
    requestedBy: { userId: '9', name: 'Bola Barman' },
    requestedAt: '2027-07-01T18:00:00Z',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    lines: [
      { stockItemId: '20', name: 'Coke', unit: 'bottle', archived: false, quantityRequested: '12.000', quantityIssued: null, availableAtSource: '30.000' },
      { stockItemId: '21', name: 'Gin', unit: 'bottle', archived: false, quantityRequested: '2.000', quantityIssued: null, availableAtSource: '1.000' },
    ],
    ...overrides,
  };
}

describe('<StockRequestsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([STORE, BAR]);
    mocks.listStockItems.mockResolvedValue([COKE, GIN]);
    mocks.listTransferRequests.mockResolvedValue([]);
    mocks.getMyRequestOutlets.mockResolvedValue({ restricted: false, outletIds: null });
  });

  describe('raising a request', () => {
    it('starts from the store, and sends several items in one request', async () => {
      mocks.createTransferRequest.mockResolvedValue({ id: '7', fromOutlet: { name: 'Main Store' } });
      render(<StockRequestsTab permissions={REQUESTER} />);

      await waitFor(() => expect(screen.getByLabelText('Request from')).toHaveValue('1'));
      expect(mocks.listStockItems).toHaveBeenCalledWith({ outletId: '1' });
      await selectWhenLoaded('Deliver to', '2');
      await selectWhenLoaded('Item 1', '20');
      expect(screen.getByText('30.000 bottle at the store now')).toBeInTheDocument();
      await userEvent.type(screen.getByLabelText('Quantity 1'), '12');
      await userEvent.click(screen.getByRole('button', { name: 'Add another item' }));
      await selectWhenLoaded('Item 2', '21');
      await userEvent.type(screen.getByLabelText('Quantity 2'), '2.5');
      await userEvent.type(screen.getByLabelText('Note (optional)'), 'Friday night');
      await userEvent.click(screen.getByRole('button', { name: 'Send request' }));

      expect(mocks.createTransferRequest).toHaveBeenCalledWith({
        fromOutletId: '1',
        toOutletId: '2',
        lines: [
          { stockItemId: '20', quantity: '12' },
          { stockItemId: '21', quantity: '2.5' },
        ],
        note: 'Friday night',
      });
      expect(await screen.findByText('Request #7 sent to Main Store.')).toBeInTheDocument();
      expect(mocks.listTransferRequests).toHaveBeenCalledTimes(2); // the initial load, then the refresh after sending
      expect(screen.getByLabelText('Quantity 1')).toHaveValue('');
    });

    it('staff tied to one outlet deliver only there, already chosen', async () => {
      mocks.getMyRequestOutlets.mockResolvedValue({ restricted: true, outletIds: ['2'] });
      render(<StockRequestsTab permissions={REQUESTER} />);
      await waitFor(() => expect(screen.getByLabelText('Deliver to')).toHaveValue('2'));
      const options = within(screen.getByLabelText('Deliver to')).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual(['Select your outlet', 'Main Bar']);
    });

    it('unrestricted staff can deliver to any outlet', async () => {
      render(<StockRequestsTab permissions={REQUESTER} />);
      await waitFor(() => expect(within(screen.getByLabelText('Deliver to')).getAllByRole('option')).toHaveLength(3));
      expect(screen.getByLabelText('Deliver to')).toHaveValue('');
    });

    it('never offers an item already on another line, and will not send a zero quantity', async () => {
      render(<StockRequestsTab permissions={REQUESTER} />);
      await selectWhenLoaded('Deliver to', '2');
      await selectWhenLoaded('Item 1', '20');
      await userEvent.click(screen.getByRole('button', { name: 'Add another item' }));
      expect(within(screen.getByLabelText('Item 2')).queryByRole('option', { name: 'Coke (bottle)' })).not.toBeInTheDocument();

      await userEvent.type(screen.getByLabelText('Quantity 1'), '0');
      expect(screen.getByText('More than zero, at most 3 decimal places.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
    });

    it('shows the server’s reason when a request is refused', async () => {
      mocks.createTransferRequest.mockRejectedValue(new ApiError({ status: 400, code: 'VALIDATION_STOCK_ITEM_NOT_FOUND', message: 'The specified stock item does not exist.' }));
      render(<StockRequestsTab permissions={REQUESTER} />);
      await selectWhenLoaded('Deliver to', '2');
      await selectWhenLoaded('Item 1', '20');
      await userEvent.type(screen.getByLabelText('Quantity 1'), '1');
      await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The specified stock item does not exist.');
    });

    it('a storekeeper does not get the request form', async () => {
      render(<StockRequestsTab permissions={STOREKEEPER} />);
      expect(await screen.findByText('No pending requests.')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Request stock' })).not.toBeInTheDocument();
    });
  });

  describe('issuing a request', () => {
    it('a storekeeper starts on pending requests and sends what the store holds by default', async () => {
      mocks.listTransferRequests.mockResolvedValue([pendingRequest()]);
      mocks.issueTransferRequest.mockResolvedValue(pendingRequest({ status: 'issued' }));
      render(<StockRequestsTab permissions={STOREKEEPER} />);

      expect(mocks.listTransferRequests).toHaveBeenCalledWith({ status: 'pending', limit: 100 });
      await userEvent.click(await screen.findByRole('button', { name: 'Review #5' }));
      // All 12 Coke (30 on hand); only the 1 Gin the store holds of the 2 asked.
      expect(screen.getByLabelText('Send Coke')).toHaveValue('12.000');
      expect(screen.getByLabelText('Send Gin')).toHaveValue('1.000');

      await userEvent.type(screen.getByLabelText('Issue note (optional)'), 'With the porter');
      await userEvent.click(screen.getByRole('button', { name: 'Issue stock' }));
      expect(mocks.issueTransferRequest).toHaveBeenCalledWith('5', {
        lines: [
          { stockItemId: '20', quantity: '12.000' },
          { stockItemId: '21', quantity: '1.000' },
        ],
        note: 'With the porter',
      });
      expect(await screen.findByText('Request #5 issued — the stock is now at Main Bar.')).toBeInTheDocument();
    });

    it('opening a request brings its panel (and the Issue button) into view and focus', async () => {
      const scrollIntoView = vi.fn();
      window.Element.prototype.scrollIntoView = scrollIntoView;
      mocks.listTransferRequests.mockResolvedValue([pendingRequest()]);
      render(<StockRequestsTab permissions={STOREKEEPER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Review #5' }));

      const panel = screen.getByRole('region', { name: 'Request #5' });
      // Above the list, so the list (re)loading can never push it off screen.
      const list = screen.getByRole('heading', { name: 'Stock requests' });
      expect(panel.compareDocumentPosition(list) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(panel);
      expect(panel).toHaveFocus();
      delete window.Element.prototype.scrollIntoView;
    });

    it('will not send more than was asked or more than the store holds', async () => {
      mocks.listTransferRequests.mockResolvedValue([pendingRequest()]);
      render(<StockRequestsTab permissions={STOREKEEPER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Review #5' }));

      const gin = screen.getByLabelText('Send Gin');
      await userEvent.clear(gin);
      await userEvent.type(gin, '2');
      expect(screen.getByRole('alert')).toHaveTextContent('no more than Main Store holds');
      expect(screen.getByRole('button', { name: 'Issue stock' })).toBeDisabled();

      await userEvent.clear(gin);
      await userEvent.type(gin, '0');
      const coke = screen.getByLabelText('Send Coke');
      await userEvent.clear(coke);
      await userEvent.type(coke, '0');
      expect(screen.getByRole('button', { name: 'Issue stock' })).toBeDisabled(); // nothing to send — reject instead
    });

    it('shows the server’s refusal and refreshes the list', async () => {
      mocks.listTransferRequests.mockResolvedValue([pendingRequest()]);
      mocks.issueTransferRequest.mockRejectedValue(
        new ApiError({ status: 422, code: 'BUSINESS_RULE_INSUFFICIENT_STOCK_FOR_TRANSFER', message: 'Not enough stock to send: "Coke". Lower that line and issue again — nothing was sent.' }),
      );
      render(<StockRequestsTab permissions={STOREKEEPER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Review #5' }));
      await userEvent.click(screen.getByRole('button', { name: 'Issue stock' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('nothing was sent');
      expect(mocks.listTransferRequests).toHaveBeenCalledTimes(2);
    });

    it('rejecting needs a reason, which is sent to the server', async () => {
      mocks.listTransferRequests.mockResolvedValue([pendingRequest()]);
      mocks.rejectTransferRequest.mockResolvedValue(pendingRequest({ status: 'rejected' }));
      render(<StockRequestsTab permissions={STOREKEEPER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Review #5' }));
      await userEvent.click(screen.getByRole('button', { name: 'Reject request' }));

      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByRole('button', { name: 'Reject request' })).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText('Reason'), 'Counting tonight');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Reject request' }));
      expect(mocks.rejectTransferRequest).toHaveBeenCalledWith('5', { reason: 'Counting tonight' });
      expect(await screen.findByText('Request #5 rejected.')).toBeInTheDocument();
    });

    it('is disabled offline', async () => {
      mocks.listTransferRequests.mockResolvedValue([pendingRequest()]);
      render(<StockRequestsTab permissions={STOREKEEPER} isOffline />);
      await userEvent.click(await screen.findByRole('button', { name: 'Review #5' }));
      expect(screen.getByRole('button', { name: 'Issue stock' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Reject request' })).toBeDisabled();
    });
  });

  describe('following a request', () => {
    it('a requester sees every status by default, and what was sent on an issued request', async () => {
      const issued = pendingRequest({
        status: 'issued',
        decidedBy: { userId: '4', name: 'Kemi Store' },
        decidedAt: '2027-07-01T19:00:00Z',
        lines: [{ stockItemId: '20', name: 'Coke', unit: 'bottle', archived: false, quantityRequested: '12.000', quantityIssued: '8.000', availableAtSource: null }],
      });
      mocks.listTransferRequests.mockResolvedValue([issued]);
      render(<StockRequestsTab permissions={REQUESTER} />);

      expect(mocks.listTransferRequests).toHaveBeenCalledWith({ status: undefined, limit: 100 });
      await userEvent.click(await screen.findByRole('button', { name: 'View #5' }));
      expect(screen.getByText('8.000 bottle')).toBeInTheDocument();
      expect(screen.getByText(/Issued by Kemi Store/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Issue stock' })).not.toBeInTheDocument();
    });

    it('a requester can withdraw a pending request but not issue it', async () => {
      mocks.listTransferRequests.mockResolvedValue([pendingRequest()]);
      mocks.cancelTransferRequest.mockResolvedValue(pendingRequest({ status: 'cancelled' }));
      render(<StockRequestsTab permissions={REQUESTER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'View #5' }));
      expect(screen.queryByRole('button', { name: 'Issue stock' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Send Coke')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Withdraw request' }));
      expect(mocks.cancelTransferRequest).toHaveBeenCalledWith('5');
      expect(await screen.findByText('Request #5 withdrawn.')).toBeInTheDocument();
    });

    it('a notification opens its request even when the list is filtered away from it', async () => {
      const issued = pendingRequest({ status: 'issued', lines: [{ stockItemId: '20', name: 'Coke', unit: 'bottle', archived: false, quantityRequested: '12.000', quantityIssued: '12.000', availableAtSource: null }] });
      mocks.getTransferRequest.mockResolvedValue(issued);
      render(<StockRequestsTab permissions={STOREKEEPER} intent={{ requestId: '5', nonce: 1 }} />);

      expect(await screen.findByRole('heading', { name: 'Request #5 — Main Store → Main Bar' })).toBeInTheDocument();
      expect(mocks.listTransferRequests).toHaveBeenCalledWith({ status: 'pending', limit: 100 }); // the list is still Pending; the request opens anyway
      expect(screen.getByText('No pending requests.')).toBeInTheDocument();
    });

    it('a pending request opened from a notification can be issued, and closes once the refreshed list no longer has it', async () => {
      mocks.getTransferRequest.mockResolvedValue(pendingRequest());
      mocks.issueTransferRequest.mockResolvedValue(pendingRequest({ status: 'issued' }));
      render(<StockRequestsTab permissions={STOREKEEPER} intent={{ requestId: '5', nonce: 1 }} />);

      expect(await screen.findByLabelText('Send Coke')).toHaveValue('12.000');
      await userEvent.click(screen.getByRole('button', { name: 'Issue stock' }));
      expect(await screen.findByText('Request #5 issued — the stock is now at Main Bar.')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Request #5 — Main Store → Main Bar' })).not.toBeInTheDocument();
    });

    it('a notification brings the opened request into view too', async () => {
      const scrollIntoView = vi.fn();
      window.Element.prototype.scrollIntoView = scrollIntoView;
      mocks.getTransferRequest.mockResolvedValue(pendingRequest());
      render(<StockRequestsTab permissions={STOREKEEPER} intent={{ requestId: '5', nonce: 1 }} />);
      const panel = await screen.findByRole('region', { name: 'Request #5' });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(panel).toHaveFocus();
      delete window.Element.prototype.scrollIntoView;
    });

    it('says so when the request a notification pointed at is gone', async () => {
      mocks.getTransferRequest.mockRejectedValue(new ApiError({ status: 404, code: null, message: 'Not found.' }));
      render(<StockRequestsTab permissions={STOREKEEPER} intent={{ requestId: '99', nonce: 1 }} />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Request #99 could not be found.');
    });

    it('a slow answer for an earlier filter never replaces the current one', async () => {
      let resolveFirst;
      mocks.listTransferRequests
        .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
        .mockResolvedValueOnce([pendingRequest({ id: '8', status: 'issued' })]);
      render(<StockRequestsTab permissions={STOREKEEPER} />);

      await userEvent.selectOptions(screen.getByLabelText('Show'), 'issued');
      expect(await screen.findByRole('button', { name: 'View #8' })).toBeInTheDocument();
      resolveFirst([pendingRequest({ id: '5' })]);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Review #5' })).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'View #8' })).toBeInTheDocument();
    });
  });
  describe('topping up a short issue', () => {
    function issuedShort(overrides = {}) {
      return pendingRequest({
        status: 'issued',
        decidedBy: { userId: '8', name: 'Kemi Store' },
        decidedAt: '2027-07-01T19:00:00Z',
        topUpOfRequestId: null,
        topUps: [],
        lines: [
          { stockItemId: '20', name: 'Coke', unit: 'bottle', archived: false, quantityRequested: '12.000', quantityIssued: '12.000', availableAtSource: null },
          { stockItemId: '21', name: 'Gin', unit: 'bottle', archived: false, quantityRequested: '2.000', quantityIssued: '0.500', availableAtSource: null },
        ],
        ...overrides,
      });
    }

    it('"Request the rest" fills the form with only what was not sent, between the same outlets, and links the new request', async () => {
      mocks.listTransferRequests.mockResolvedValue([issuedShort()]);
      mocks.createTransferRequest.mockResolvedValue({ id: '9', fromOutlet: { name: 'Main Store' } });
      render(<StockRequestsTab permissions={REQUESTER} />);

      await userEvent.click(await screen.findByRole('button', { name: 'View #5' }));
      expect(screen.getByText('Sent short: Gin 1.500 bottle missing.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Request the rest' }));

      expect(screen.getByText('Request the rest of #5')).toBeInTheDocument();
      expect(screen.getByLabelText('Request from')).toHaveValue('1');
      expect(screen.getByLabelText('Request from')).toBeDisabled();
      expect(screen.getByLabelText('Deliver to')).toHaveValue('2');
      expect(screen.getByLabelText('Deliver to')).toBeDisabled();
      await waitFor(() => expect(screen.getByLabelText(/^Item 1/)).toHaveValue('21'));
      expect(screen.getByText('1.000 bottle at the store now')).toBeInTheDocument();
      expect(screen.getByLabelText('Quantity 1')).toHaveValue('1.500');
      expect(screen.queryByLabelText('Item 2')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Note (optional)')).toHaveValue('Top-up of #5');

      // Editable: ask for less than the shortfall.
      await userEvent.clear(screen.getByLabelText('Quantity 1'));
      await userEvent.type(screen.getByLabelText('Quantity 1'), '1');
      await userEvent.click(screen.getByRole('button', { name: 'Send top-up' }));

      expect(mocks.createTransferRequest).toHaveBeenCalledWith({
        fromOutletId: '1',
        toOutletId: '2',
        lines: [{ stockItemId: '21', quantity: '1' }],
        note: 'Top-up of #5',
        topUpOfRequestId: '5',
      });
      expect(await screen.findByText('Top-up #9 of request #5 sent to Main Store.')).toBeInTheDocument();
      expect(screen.getByText('Request stock')).toBeInTheDocument();
      expect(screen.getByLabelText('Request from')).not.toBeDisabled();
    });

    it('"Not a top-up" turns the form back into an ordinary request', async () => {
      mocks.listTransferRequests.mockResolvedValue([issuedShort()]);
      render(<StockRequestsTab permissions={REQUESTER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'View #5' }));
      await userEvent.click(screen.getByRole('button', { name: 'Request the rest' }));
      await userEvent.click(screen.getByRole('button', { name: 'Not a top-up' }));

      expect(screen.getByText('Request stock')).toBeInTheDocument();
      expect(screen.getByLabelText('Item 1')).toHaveValue('');
      expect(screen.getByLabelText('Note (optional)')).toHaveValue('');
      expect(screen.getByLabelText('Request from')).not.toBeDisabled();
    });

    it('is not offered when the request was sent in full, already has a live top-up, or to a storekeeper', async () => {
      const full = issuedShort({ id: '6', lines: [issuedShort().lines[0]] });
      const toppedUp = issuedShort({ id: '5', topUps: [{ id: '9', status: 'pending' }] });
      mocks.listTransferRequests.mockResolvedValue([toppedUp, full]);
      const { unmount } = render(<StockRequestsTab permissions={REQUESTER} />);

      await userEvent.click(await screen.findByRole('button', { name: 'View #6' }));
      expect(screen.queryByText(/Sent short/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Request the rest' })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'View #5' }));
      expect(screen.getByText('Topped up by #9 (pending).')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Request the rest' })).not.toBeInTheDocument();
      unmount();

      mocks.listTransferRequests.mockResolvedValue([issuedShort()]);
      render(<StockRequestsTab permissions={STOREKEEPER} />);
      await userEvent.selectOptions(screen.getByLabelText('Show'), '');
      await userEvent.click(await screen.findByRole('button', { name: 'View #5' }));
      expect(screen.getByText('Sent short: Gin 1.500 bottle missing.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Request the rest' })).not.toBeInTheDocument();
    });

    it('a withdrawn top-up frees the shortfall again, and the links open the other request', async () => {
      const original = issuedShort({ topUps: [{ id: '9', status: 'cancelled' }] });
      mocks.listTransferRequests.mockResolvedValue([original]);
      mocks.getTransferRequest.mockResolvedValue(pendingRequest({ id: '9', status: 'cancelled', topUpOfRequestId: '5', topUps: [] }));
      render(<StockRequestsTab permissions={REQUESTER} />);

      await userEvent.click(await screen.findByRole('button', { name: 'View #5' }));
      expect(screen.getByText('Topped up by #9 (withdrawn).')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Request the rest' })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'View #9' }));
      expect(mocks.getTransferRequest).toHaveBeenCalledWith('9');
      expect(await screen.findByText('Top-up of request #5.')).toBeInTheDocument();
    });

    it('marks a top-up in the list', async () => {
      mocks.listTransferRequests.mockResolvedValue([pendingRequest({ id: '9', topUpOfRequestId: '5', topUps: [] })]);
      render(<StockRequestsTab permissions={REQUESTER} />);
      expect(await screen.findByText('#9 (top-up of #5)')).toBeInTheDocument();
    });
  });
});
