import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QrTokensTab } from '../QrTokensTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listQrTokens: vi.fn(),
  createQrToken: vi.fn(),
  regenerateQrToken: vi.fn(),
  deactivateQrToken: vi.fn(),
  reactivateQrToken: vi.fn(),
  toggleGuestOrdering: vi.fn(),
  updateGuestOrderPolicy: vi.fn(),
  listRooms: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: {
      listOutlets: mocks.listOutlets,
      listQrTokens: mocks.listQrTokens,
      createQrToken: mocks.createQrToken,
      regenerateQrToken: mocks.regenerateQrToken,
      deactivateQrToken: mocks.deactivateQrToken,
      reactivateQrToken: mocks.reactivateQrToken,
      toggleGuestOrdering: mocks.toggleGuestOrdering,
      updateGuestOrderPolicy: mocks.updateGuestOrderPolicy,
    },
    setupApi: { listRooms: mocks.listRooms },
  };
});

function outlet(overrides) {
  return {
    id: '1',
    name: 'Poolside Bar',
    guest_ordering_enabled: true,
    guest_order_accept_timeout_minutes: 10,
    guest_order_rate_limit_max: 5,
    guest_order_max_unpaid_value: null,
    ...overrides,
  };
}

function token(overrides) {
  return { id: '9', type: 'table', table_label: 'T1', room_id: null, active: true, raw_token: 'raw-abc', ...overrides };
}

describe('<QrTokensTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRooms.mockResolvedValue([{ id: '3', room_number: '101' }]);
  });

  it('lists real outlets with their real guest-ordering state', async () => {
    mocks.listOutlets.mockResolvedValue([outlet()]);
    render(<QrTokensTab />);
    expect(await screen.findByText('Poolside Bar')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('shows a real backend error when outlets fail to load', async () => {
    mocks.listOutlets.mockRejectedValue(new Error('boom'));
    render(<QrTokensTab />);
    expect(await screen.findByText('Could not load outlets.')).toBeInTheDocument();
  });

  it('selecting an outlet loads its real tokens and pre-fills the real policy form', async () => {
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listQrTokens.mockResolvedValue([token()]);
    render(<QrTokensTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));

    expect(mocks.listQrTokens).toHaveBeenCalledWith('1');
    expect(await screen.findByText('T1')).toBeInTheDocument();
    expect(screen.getByLabelText('Accept timeout (minutes)')).toHaveValue(10);
    expect(screen.getByLabelText('Max orders per code (per hour)')).toHaveValue(5);
    expect(screen.getByText(/qr-order\/raw-abc\/menu/)).toBeInTheDocument();
  });

  it('toggling guest ordering calls the real endpoint with the flipped value', async () => {
    mocks.listOutlets.mockResolvedValue([outlet({ guest_ordering_enabled: true })]);
    mocks.listQrTokens.mockResolvedValue([]);
    mocks.toggleGuestOrdering.mockResolvedValue(outlet({ guest_ordering_enabled: false }));
    render(<QrTokensTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Disable guest ordering' }));

    expect(mocks.toggleGuestOrdering).toHaveBeenCalledWith('1', false);
    expect(await screen.findByRole('button', { name: 'Enable guest ordering' })).toBeInTheDocument();
  });

  it('saves a real policy update', async () => {
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listQrTokens.mockResolvedValue([]);
    mocks.updateGuestOrderPolicy.mockResolvedValue(outlet({ guest_order_accept_timeout_minutes: 20 }));
    render(<QrTokensTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const timeoutInput = await screen.findByLabelText('Accept timeout (minutes)');
    await userEvent.clear(timeoutInput);
    await userEvent.type(timeoutInput, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(mocks.updateGuestOrderPolicy).toHaveBeenCalledWith('1', { acceptTimeoutMinutes: 20, rateLimitMax: 5, maxUnpaidValue: null });
  });

  it('creates a table QR code and shows the real scannable image, then re-lists the real tokens', async () => {
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listQrTokens.mockResolvedValueOnce([]).mockResolvedValueOnce([token()]);
    mocks.createQrToken.mockResolvedValue({ token: token(), qrImageDataUrl: 'data:image/png;base64,abc', rawToken: 'raw-abc' });
    render(<QrTokensTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.type(await screen.findByLabelText('Table label'), 'T1');
    await userEvent.click(screen.getByRole('button', { name: 'Create QR code' }));

    expect(mocks.createQrToken).toHaveBeenCalledWith(
      expect.objectContaining({ outletId: '1', type: 'table', tableLabel: 'T1', baseUrl: expect.stringContaining('/qr-order') })
    );
    expect(await screen.findByAltText('Scannable QR code for this table or room')).toHaveAttribute('src', 'data:image/png;base64,abc');
    await waitFor(() => expect(mocks.listQrTokens).toHaveBeenCalledTimes(2));
  });

  it('creating a room code offers the real room list', async () => {
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listQrTokens.mockResolvedValue([]);
    render(<QrTokensTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));

    await userEvent.selectOptions(await screen.findByLabelText('Type'), 'room');
    expect(await screen.findByRole('option', { name: '101' })).toBeInTheDocument();
  });

  it('regenerates a token for real — the old code is gone from view, replaced by the new scannable image', async () => {
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listQrTokens.mockResolvedValue([token()]);
    mocks.regenerateQrToken.mockResolvedValue({ token: token({ id: '10' }), qrImageDataUrl: 'data:image/png;base64,new', rawToken: 'raw-new' });
    render(<QrTokensTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await screen.findByText('T1');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(mocks.regenerateQrToken).toHaveBeenCalledWith('9', expect.stringContaining('/qr-order'));
    expect(await screen.findByAltText('Scannable QR code for this table or room')).toHaveAttribute('src', 'data:image/png;base64,new');
  });

  it('deactivates and reactivates a token for real', async () => {
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listQrTokens.mockResolvedValueOnce([token()]).mockResolvedValueOnce([token({ active: false })]).mockResolvedValueOnce([token({ active: true })]);
    mocks.deactivateQrToken.mockResolvedValue({});
    mocks.reactivateQrToken.mockResolvedValue({});
    render(<QrTokensTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await screen.findByText('T1');
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(mocks.deactivateQrToken).toHaveBeenCalledWith('9');

    await userEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    expect(mocks.reactivateQrToken).toHaveBeenCalledWith('9');
  });
});
