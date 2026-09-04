import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingScreen } from '../BookingScreen.jsx';

const mocks = vi.hoisted(() => ({
  listProperties: vi.fn(),
  listRoomTypes: vi.fn(),
  listRateCodes: vi.fn(),
  listRooms: vi.fn(),
  listGuests: vi.fn(),
  listReservations: vi.fn(),
  listWaitlist: vi.fn(),
  listArrivals: vi.fn(),
  listDepartures: vi.fn(),
  listInHouse: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      listProperties: mocks.listProperties,
      listRoomTypes: mocks.listRoomTypes,
      listRateCodes: mocks.listRateCodes,
      listRooms: mocks.listRooms,
    },
    reservationsApi: {
      listGuests: mocks.listGuests,
      listReservations: mocks.listReservations,
      listWaitlist: mocks.listWaitlist,
      listArrivals: mocks.listArrivals,
      listDepartures: mocks.listDepartures,
      listInHouse: mocks.listInHouse,
    },
  };
});

const PROPERTY = { id: '1', name: 'Alpha Hotels', base_currency: 'NGN' };

describe('<BookingScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.listRateCodes.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
    mocks.listGuests.mockResolvedValue([]);
    mocks.listReservations.mockResolvedValue([]);
    mocks.listWaitlist.mockResolvedValue([]);
    mocks.listArrivals.mockResolvedValue([]);
    mocks.listDepartures.mockResolvedValue([]);
    mocks.listInHouse.mockResolvedValue([]);
  });

  it('shows a loading state before properties resolve', () => {
    mocks.listProperties.mockImplementation(() => new Promise(() => {}));
    render(<BookingScreen activePropertyId="1" />);
    expect(screen.getByText(/loading booking/i)).toBeInTheDocument();
  });

  it('asks to select a property when the active property id matches none', async () => {
    mocks.listProperties.mockResolvedValue([PROPERTY]);
    render(<BookingScreen activePropertyId="999" />);
    expect(await screen.findByText(/select an active property/i)).toBeInTheDocument();
  });

  it('renders all five tabs and defaults to Availability', async () => {
    mocks.listProperties.mockResolvedValue([PROPERTY]);
    render(<BookingScreen activePropertyId="1" />);
    expect(await screen.findByRole('tab', { name: 'Availability' })).toHaveAttribute('aria-selected', 'true');
    ['Tape Chart', 'Reservations', 'Waitlist', 'Front Desk'].forEach((label) => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
  });

  it('switches tabs on click, without crashing', async () => {
    mocks.listProperties.mockResolvedValue([PROPERTY]);
    render(<BookingScreen activePropertyId="1" />);
    await screen.findByRole('tab', { name: 'Availability' });

    await userEvent.click(screen.getByRole('tab', { name: 'Reservations' }));
    expect(screen.getByRole('tab', { name: 'Reservations' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('tab', { name: 'Front Desk' }));
    expect(await screen.findByRole('tab', { name: 'Arrivals' })).toBeInTheDocument();
  });
});
