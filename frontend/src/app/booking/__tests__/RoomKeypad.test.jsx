import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomKeypad } from '../RoomKeypad.jsx';

const ROOMS = [
  { id: '1', room_number: '101', floor: '1', available: true, reason: null },
  { id: '2', room_number: '102', floor: null, available: false, reason: 'occupied' },
  { id: '3', room_number: '103', floor: '1', available: false, reason: 'reserved' },
  { id: '4', room_number: '104', floor: '1', available: false, reason: 'not_clean' },
  { id: '5', room_number: '105', floor: '1', available: false, reason: 'out_of_order' },
  { id: '6', room_number: '106', floor: '1', available: false, reason: 'discrepancy' },
];

describe('<RoomKeypad>', () => {
  it('shows every room with its state in words and why a taken room is taken, with counts', () => {
    render(<RoomKeypad rooms={ROOMS} roomTypeName="Deluxe" selectedId="" onSelect={() => {}} />);
    expect(screen.getByText('Rooms — Deluxe')).toBeInTheDocument();
    expect(screen.getByText('1 available')).toBeInTheDocument();
    expect(screen.getByText('5 not available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Room 101, Available' })).toBeEnabled();
    expect(screen.getByText('Floor 1')).toBeInTheDocument();
    for (const [number, why] of [['102', 'Occupied'], ['103', 'Reserved'], ['104', 'Not clean yet'], ['105', 'Out of order'], ['106', 'Under review']]) {
      const tile = screen.getByRole('button', { name: `Room ${number}, Not available — ${why}` });
      expect(tile).toBeDisabled();
      expect(tile).toHaveTextContent('Not available');
    }
  });

  it('tapping an available room picks it; tapping the picked room clears it; a taken room does nothing', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<RoomKeypad rooms={ROOMS} selectedId="" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Room 101, Available' }));
    expect(onSelect).toHaveBeenLastCalledWith('1');
    await userEvent.click(screen.getByRole('button', { name: /Room 102/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender(<RoomKeypad rooms={ROOMS} selectedId="1" onSelect={onSelect} />);
    const selected = screen.getByRole('button', { name: 'Room 101, Selected' });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(selected);
    expect(onSelect).toHaveBeenLastCalledWith('');
  });

  it('can be locked (offline or already booked), and says so while loading or when a type has no rooms', () => {
    const { rerender } = render(<RoomKeypad rooms={ROOMS} selectedId="" onSelect={() => {}} disabled />);
    expect(screen.getByRole('button', { name: 'Room 101, Available' })).toBeDisabled();
    rerender(<RoomKeypad rooms={null} selectedId="" onSelect={() => {}} />);
    expect(screen.getByText('Loading rooms…')).toBeInTheDocument();
    rerender(<RoomKeypad rooms={[]} selectedId="" onSelect={() => {}} />);
    expect(screen.getByText('This room type has no rooms set up yet.')).toBeInTheDocument();
  });
});
