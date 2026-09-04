import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomTypesTab } from '../RoomTypesTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listRoomTypes: vi.fn(),
  createRoomType: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { listRoomTypes: mocks.listRoomTypes, createRoomType: mocks.createRoomType },
  };
});

const PROPERTY = { id: '1', base_currency: 'NGN' };

describe('<RoomTypesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('shows a disabled notice with no active property, and never calls the API', () => {
    render(<RoomTypesTab activeProperty={null} disabled />);
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
    expect(mocks.listRoomTypes).not.toHaveBeenCalled();
  });

  it('shows the empty state with no room types yet', async () => {
    mocks.listRoomTypes.mockResolvedValue([]);
    render(<RoomTypesTab activeProperty={PROPERTY} disabled={false} />);
    expect(await screen.findByText(/no room types yet/i)).toBeInTheDocument();
  });

  it('lists existing room types with money formatted through the currency, never a hardcoded symbol', async () => {
    mocks.listRoomTypes.mockResolvedValue([
      { id: '1', code: 'DLX', name: 'Deluxe', default_occupancy: 2, base_rate: '150.00' },
    ]);
    render(<RoomTypesTab activeProperty={PROPERTY} disabled={false} />);
    expect(await screen.findByText('DLX')).toBeInTheDocument();
    expect(screen.getByText('Deluxe')).toBeInTheDocument();
  });

  it('creates a room type and reloads the list', async () => {
    mocks.listRoomTypes.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: '1', code: 'STD', name: 'Standard', default_occupancy: 2, base_rate: '100.00' },
    ]);
    mocks.createRoomType.mockResolvedValue({ id: '1', code: 'STD' });
    render(<RoomTypesTab activeProperty={PROPERTY} disabled={false} />);
    await screen.findByText(/no room types yet/i);

    await userEvent.type(screen.getByPlaceholderText('DLX'), 'STD');
    await userEvent.type(screen.getByPlaceholderText('Deluxe'), 'Standard');
    await userEvent.clear(screen.getByLabelText(/default occupancy/i));
    await userEvent.type(screen.getByLabelText(/default occupancy/i), '2');
    await userEvent.type(screen.getByPlaceholderText('150.00'), '100.00');
    await userEvent.click(screen.getByRole('button', { name: 'Add room type' }));

    expect(mocks.createRoomType).toHaveBeenCalledWith({
      code: 'STD',
      name: 'Standard',
      default_occupancy: 2,
      base_rate: '100.00',
      description: undefined,
    });
    expect(await screen.findByText('Standard')).toBeInTheDocument();
  });

  it('shows the backend error message on a duplicate code, and does not clear the form', async () => {
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.createRoomType.mockRejectedValue(
      new ApiError({ code: 'CONFLICT_DUPLICATE_ENTRY', message: 'A room type with code "DLX" already exists at this property.' })
    );
    render(<RoomTypesTab activeProperty={PROPERTY} disabled={false} />);
    await screen.findByText(/no room types yet/i);

    await userEvent.type(screen.getByPlaceholderText('DLX'), 'DLX');
    await userEvent.type(screen.getByPlaceholderText('Deluxe'), 'Deluxe');
    await userEvent.type(screen.getByPlaceholderText('150.00'), '150.00');
    await userEvent.click(screen.getByRole('button', { name: 'Add room type' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists at this property');
    expect(screen.getByPlaceholderText('DLX')).toHaveValue('DLX');
  });
});
