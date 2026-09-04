import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupScreen } from '../SetupScreen.jsx';

const mocks = vi.hoisted(() => ({
  listProperties: vi.fn(),
  listRoomTypes: vi.fn(),
  listRooms: vi.fn(),
  listRateCodes: vi.fn(),
  listTaxes: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      listProperties: mocks.listProperties,
      listRoomTypes: mocks.listRoomTypes,
      listRooms: mocks.listRooms,
      listRateCodes: mocks.listRateCodes,
      listTaxes: mocks.listTaxes,
    },
  };
});

const PROPERTY = { id: '1', name: 'Alpha Hotels', slug: 'alpha', timezone: 'Africa/Lagos', base_currency: 'NGN', current_business_date: '2026-09-01' };

describe('<SetupScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
    mocks.listRateCodes.mockResolvedValue([]);
    mocks.listTaxes.mockResolvedValue([]);
  });

  it('shows a loading state before properties resolve', () => {
    mocks.listProperties.mockImplementation(() => new Promise(() => {}));
    render(<SetupScreen activePropertyId="1" />);
    expect(screen.getByText(/loading setup/i)).toBeInTheDocument();
  });

  it('renders all five tabs once properties load, defaulting to Property', async () => {
    mocks.listProperties.mockResolvedValue([PROPERTY]);
    render(<SetupScreen activePropertyId="1" />);
    expect(await screen.findByRole('tab', { name: 'Property' })).toHaveAttribute('aria-selected', 'true');
    ['Room Types', 'Rooms', 'Rate Codes & Calendar', 'Taxes'].forEach((label) => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
  });

  it('switches tabs on click', async () => {
    mocks.listProperties.mockResolvedValue([PROPERTY]);
    render(<SetupScreen activePropertyId="1" />);
    await screen.findByRole('tab', { name: 'Property' });

    await userEvent.click(screen.getByRole('tab', { name: 'Room Types' }));
    expect(screen.getByRole('tab', { name: 'Room Types' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Property' })).toHaveAttribute('aria-selected', 'false');
  });

  it('disables property-dependent tabs with an explanatory notice when no property exists yet', async () => {
    mocks.listProperties.mockResolvedValue([]);
    render(<SetupScreen activePropertyId={null} />);
    await screen.findByRole('tab', { name: 'Property' });

    await userEvent.click(screen.getByRole('tab', { name: 'Room Types' }));
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
  });

  it('shows an error banner when properties fail to load', async () => {
    mocks.listProperties.mockRejectedValue(new Error('network down'));
    render(<SetupScreen activePropertyId="1" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
