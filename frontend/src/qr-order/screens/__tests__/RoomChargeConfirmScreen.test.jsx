import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../shared/api/index.js';
import { RoomChargeConfirmScreen } from '../RoomChargeConfirmScreen.jsx';
import { renderQrOrderScreen, TOKEN } from './renderQrOrderScreen.jsx';

const mocks = vi.hoisted(() => ({
  confirmRoomChargeName: vi.fn(),
  requestRoomChargeOtp: vi.fn(),
  verifyRoomChargeOtp: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    qrOrderingApi: {
      confirmRoomChargeName: mocks.confirmRoomChargeName,
      requestRoomChargeOtp: mocks.requestRoomChargeOtp,
      verifyRoomChargeOtp: mocks.verifyRoomChargeOtp,
    },
  };
});

function StatusStub() {
  return <p>status screen</p>;
}

function renderScreen() {
  return renderQrOrderScreen({
    element: <RoomChargeConfirmScreen />,
    routePath: 'orders/:id/room-charge',
    initialPath: `/qr-order/${TOKEN}/orders/42/room-charge`,
    otherRoutes: [{ path: 'orders/:id/status', element: <StatusStub /> }],
  });
}

describe('<RoomChargeConfirmScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('shows a genuinely masked guest name, never the full name, and can send a code', async () => {
    mocks.confirmRoomChargeName.mockResolvedValue({ maskedName: 'J*** A.' });
    mocks.requestRoomChargeOtp.mockResolvedValue({ devOnlyCode: '123456' });
    renderScreen();

    expect(await screen.findByText('J*** A.')).toBeInTheDocument();
    expect(mocks.confirmRoomChargeName).toHaveBeenCalledWith({ token: TOKEN, id: '42' });

    await userEvent.click(screen.getByRole('button', { name: 'Yes, send the code' }));
    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(mocks.requestRoomChargeOtp).toHaveBeenCalledWith({ token: TOKEN, id: '42' });
  });

  it('shows a real error when the room has no in-house reservation', async () => {
    mocks.confirmRoomChargeName.mockRejectedValue(
      new ApiError({ code: 'BUSINESS_RULE_NO_IN_HOUSE_RESERVATION', message: 'This room has no in-house guest to charge right now.' })
    );
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent('This room has no in-house guest to charge right now.');
  });

  it('shows a real, distinct message for a wrong/expired code, and lets the guest try the real one afterward', async () => {
    mocks.confirmRoomChargeName.mockResolvedValue({ maskedName: 'J*** A.' });
    mocks.requestRoomChargeOtp.mockResolvedValue({ devOnlyCode: null });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, send the code' }));
    await screen.findByLabelText('Verification code');

    mocks.verifyRoomChargeOtp.mockRejectedValueOnce(
      new ApiError({ code: 'AUTH_OTP_INVALID', message: 'The code is incorrect, expired, or already used.' })
    );
    await userEvent.type(screen.getByLabelText('Verification code'), '000001');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The code is incorrect, expired, or already used.');

    mocks.verifyRoomChargeOtp.mockResolvedValueOnce({ guestOrder: { id: '42', status: 'received', payment_status: 'charged_to_room' } });
    await userEvent.clear(screen.getByLabelText('Verification code'));
    await userEvent.type(screen.getByLabelText('Verification code'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('status screen')).toBeInTheDocument();
  });

  it('a request for a new code replaces the earlier one', async () => {
    mocks.confirmRoomChargeName.mockResolvedValue({ maskedName: 'J*** A.' });
    mocks.requestRoomChargeOtp.mockResolvedValueOnce({ devOnlyCode: '111111' });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, send the code' }));
    expect(await screen.findByText('111111')).toBeInTheDocument();

    mocks.requestRoomChargeOtp.mockResolvedValueOnce({ devOnlyCode: '222222' });
    await userEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByText('222222')).toBeInTheDocument();
    expect(screen.queryByText('111111')).not.toBeInTheDocument();
  });

  it('treats an already-paid conflict as success, going straight to the status screen', async () => {
    mocks.confirmRoomChargeName.mockResolvedValue({ maskedName: 'J*** A.' });
    mocks.requestRoomChargeOtp.mockResolvedValue({ devOnlyCode: '123456' });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, send the code' }));
    await screen.findByLabelText('Verification code');

    mocks.verifyRoomChargeOtp.mockRejectedValue(new ApiError({ code: 'CONFLICT_GUEST_ORDER_ALREADY_PAID', message: 'This order has already been paid.' }));
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('status screen')).toBeInTheDocument();
  });
});
