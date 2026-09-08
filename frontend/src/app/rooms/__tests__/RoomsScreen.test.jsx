import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomsScreen } from '../RoomsScreen.jsx';

const mocks = vi.hoisted(() => ({
  listRoomTypes: vi.fn(),
  listRooms: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      listRoomTypes: mocks.listRoomTypes,
      listRooms: mocks.listRooms,
    },
  };
});

const ACTIVE_PROPERTY = { id: '1', name: 'Fixture Hotel', base_currency: 'NGN' };

/**
 * Gap closure (user-reported): "Rooms" was a real nav item never wired to
 * any screen at all — clicking it silently fell through to Home. This
 * confirms it now mounts a real screen with Room Types/Rooms, reusing the
 * exact tabs Setup already uses, not a second copy.
 */
describe('<RoomsScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
  });

  it('defaults to the Room Types tab and can switch to Rooms', async () => {
    render(<RoomsScreen activeProperty={ACTIVE_PROPERTY} />);
    expect(await screen.findByRole('tab', { name: 'Room Types' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/no room types yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Rooms' }));
    expect(await screen.findByText(/no rooms yet/i)).toBeInTheDocument();
  });

  it('shows the real onboarding message when no property exists yet, rather than a broken form', async () => {
    render(<RoomsScreen activeProperty={null} />);
    expect(await screen.findByText(/create a property first/i)).toBeInTheDocument();
  });
});
