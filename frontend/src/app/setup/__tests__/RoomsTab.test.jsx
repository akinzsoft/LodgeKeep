import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomsTab } from '../RoomsTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';
import { selectWhenLoaded } from '../../pos/__tests__/selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listRooms: vi.fn(),
  listRoomTypes: vi.fn(),
  bulkCreateRooms: vi.fn(),
  updateRoom: vi.fn(),
  bulkChangeRoomType: vi.fn(),
  bulkArchiveRooms: vi.fn(),
  deleteRoom: vi.fn(),
  getRoomUsage: vi.fn(),
  restoreRoom: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { ...mocks },
  };
});

const ROOM_TYPE_DLX = { id: '1', code: 'DLX', name: 'Deluxe' };
const ROOM_TYPE_STD = { id: '2', code: 'STD', name: 'Standard' };
const ROOM_DLX_1 = { id: '10', room_number: '101', floor: '1', room_type_id: '1', front_desk_status: 'vacant', housekeeping_reported_status: 'clean' };
const ROOM_DLX_2 = { id: '11', room_number: '102', floor: '1', room_type_id: '1', front_desk_status: 'occupied', housekeeping_reported_status: 'dirty' };
const ROOM_STD_1 = { id: '12', room_number: '201', floor: '2', room_type_id: '2', front_desk_status: 'vacant', housekeeping_reported_status: 'clean' };

describe('<RoomsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE_DLX, ROOM_TYPE_STD]);
  });

  it('shows a real occupancy and housekeeping status pill per room, not a generic active/archived column', async () => {
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_DLX_2]);
    render(<RoomsTab disabled={false} />);
    await screen.findByText('101');

    expect(screen.getByRole('columnheader', { name: 'Occupancy' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Housekeeping' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Clean')).toBeInTheDocument();
    expect(screen.getByText('Occupied')).toBeInTheDocument();
    expect(screen.getByText('Dirty')).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "click on any roomtype it shld bring all
   * rooms associated to that room type."
   */
  it('filters to only the given room type when filterRoomTypeId is supplied', async () => {
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_DLX_2, ROOM_STD_1]);
    render(<RoomsTab disabled={false} filterRoomTypeId="1" onClearFilter={vi.fn()} />);

    await screen.findByText('101');
    expect(screen.getByText('102')).toBeInTheDocument();
    expect(screen.queryByText('201')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing rooms for/).closest('p')).toHaveTextContent('Deluxe');
  });

  it('clears the filter when "Clear filter" is clicked', async () => {
    const onClearFilter = vi.fn();
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_STD_1]);
    render(<RoomsTab disabled={false} filterRoomTypeId="1" onClearFilter={onClearFilter} />);
    await screen.findByText('101');

    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onClearFilter).toHaveBeenCalled();
  });

  it('shows every room, unfiltered, when no filterRoomTypeId is supplied (e.g. under SetupScreen)', async () => {
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_STD_1]);
    render(<RoomsTab disabled={false} />);
    await screen.findByText('101');
    expect(screen.getByText('201')).toBeInTheDocument();
    expect(screen.queryByText(/Showing rooms for/)).not.toBeInTheDocument();
  });

  // ====================================================================
  // Room management (gap closure)
  // ====================================================================
  describe('managing rooms after creation', () => {
    const blockedError = (blocked) =>
      new ApiError({ code: 'CONFLICT_ROOM_CHANGE_BLOCKED', message: 'Nothing was changed', status: 409, details: { operation: 'change_type', blocked } });

    async function renderLoaded(props = {}) {
      mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_DLX_2, ROOM_STD_1]);
      render(<RoomsTab disabled={false} {...props} />);
      await screen.findByText('101');
    }

    const rowFor = (roomNumber) => screen.getByText(roomNumber).closest('tr');

    it('offers Edit, Change type, Archive and Remove on every row', async () => {
      await renderLoaded();
      const row = within(rowFor('101'));
      for (const name of ['Edit', 'Change type', 'Archive', 'Remove']) {
        expect(row.getByRole('button', { name })).toBeEnabled();
      }
    });

    describe('rename', () => {
      it('opens a pre-filled form with the door-lock warning, and saves only the room number and floor', async () => {
        mocks.updateRoom.mockResolvedValue({ ...ROOM_DLX_1, room_number: '111' });
        await renderLoaded();
        await userEvent.click(within(rowFor('101')).getByRole('button', { name: 'Edit' }));

        expect(screen.getByLabelText('Room number')).toHaveValue('101');
        expect(screen.getByLabelText('Floor', { selector: 'input[maxlength]' })).toHaveValue('1');
        expect(screen.getByText(/door-lock software labels this room by number/)).toBeInTheDocument();

        await userEvent.clear(screen.getByLabelText('Room number'));
        await userEvent.type(screen.getByLabelText('Room number'), '111');
        await userEvent.click(screen.getByRole('button', { name: 'Save room' }));

        expect(mocks.updateRoom).toHaveBeenCalledWith('10', { room_number: '111', floor: '1' });
        expect(await screen.findByText('Saved room 111.')).toBeInTheDocument();
      });

      it('sends null when the floor is cleared, and shows the duplicate-number error', async () => {
        mocks.updateRoom.mockRejectedValue(new ApiError({ code: 'CONFLICT_DUPLICATE_ENTRY', message: 'Room "102" already exists at this property.', status: 409 }));
        await renderLoaded();
        await userEvent.click(within(rowFor('101')).getByRole('button', { name: 'Edit' }));
        await userEvent.clear(screen.getByLabelText('Floor', { selector: 'input[maxlength]' }));
        await userEvent.click(screen.getByRole('button', { name: 'Save room' }));

        expect(mocks.updateRoom).toHaveBeenCalledWith('10', { room_number: '101', floor: null });
        expect(await screen.findByRole('alert')).toHaveTextContent('Room "102" already exists');
      });
    });

    /**
     * Mobile layout check: the four row actions did not wrap, so on a phone
     * "Remove" sat outside the card. jsdom cannot measure it, so this pins the
     * markup and the rule that lets the row wrap.
     */
    it('the row actions sit in a wrapping container, so all four stay on screen on a phone', async () => {
      await renderLoaded();
      const edit = within(rowFor('101')).getByRole('button', { name: 'Edit' });
      const actions = edit.parentElement;
      for (const name of ['Change type', 'Archive', 'Remove']) {
        expect(within(rowFor('101')).getByRole('button', { name }).parentElement).toBe(actions);
      }
      expect(actions.className).toMatch(/rowActions/);

      const css = readFileSync(join(cwd(), 'src/app/setup/RoomsTab.module.css'), 'utf8');
      const block = css.slice(css.indexOf('.rowActions {'), css.indexOf('}', css.indexOf('.rowActions {')));
      expect(block).toMatch(/display:\s*flex/);
      expect(block).toMatch(/flex-wrap:\s*wrap/);
    });

    describe('selection', () => {
      it('"Select all shown" covers only the rooms currently shown, and the bulk actions appear once something is selected', async () => {
        await renderLoaded({ filterRoomTypeId: '1', onClearFilter: vi.fn() });
        expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown rooms' }));
        expect(screen.getByText('2 selected')).toBeInTheDocument(); // 101 and 102 — the Standard room is filtered out
        expect(screen.getByRole('checkbox', { name: 'Select room 101' })).toBeChecked();

        await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
        expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
      });
    });

    describe('change type', () => {
      it('sends the selected rooms and new type, reports what moved and which reservations lost their preference, and links to the new type', async () => {
        mocks.bulkChangeRoomType.mockResolvedValue({
          changed: [ROOM_DLX_1, ROOM_DLX_2],
          unchanged: [],
          cleared_preferences: [
            { reservation_id: '7', confirmation_number: 'CONF-7', room_id: '10' },
            { reservation_id: '8', confirmation_number: 'CONF-8', room_id: '11' },
          ],
          cleared_connecting_links: [],
        });
        const onFilterRoomType = vi.fn();
        await renderLoaded({ onFilterRoomType });

        await userEvent.click(screen.getByRole('checkbox', { name: 'Select room 101' }));
        await userEvent.click(screen.getByRole('checkbox', { name: 'Select room 102' }));
        await userEvent.click(screen.getAllByRole('button', { name: 'Change type' })[0]);

        const dialog = screen.getByRole('alertdialog');
        expect(within(dialog).getByRole('button', { name: 'Change type' })).toBeDisabled(); // no type chosen yet
        await selectWhenLoaded('New room type', 'Standard (STD)');
        await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'entered under the wrong type');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Change type' }));

        expect(mocks.bulkChangeRoomType).toHaveBeenCalledWith({
          room_ids: ['10', '11'],
          room_type_id: '2',
          reason: 'entered under the wrong type',
        });
        const status = await screen.findByRole('status');
        expect(status).toHaveTextContent('Moved 2 rooms to Standard.');
        expect(status).toHaveTextContent('Cleared the room preference on 2 reservations (CONF-7, CONF-8)');

        await userEvent.click(screen.getByRole('button', { name: 'View Standard rooms' }));
        expect(onFilterRoomType).toHaveBeenCalledWith('2');
        expect(screen.queryByText('2 selected')).not.toBeInTheDocument(); // selection cleared after success
      });

      it('shows every blocked room with the server\'s own sentence, says nothing was changed, and KEEPS the selection', async () => {
        mocks.bulkChangeRoomType.mockRejectedValue(
          blockedError([
            { room_id: '10', room_number: '101', reasons: [{ code: 'OCCUPIED', message: 'Room 101 is occupied by a checked-in guest.' }] },
            {
              room_id: '11',
              room_number: '102',
              reasons: [{ code: 'WOULD_OVERBOOK', message: 'Would leave Deluxe oversold on 2027-10-12: 5 booked, 4 allowed after the change.' }],
            },
            {
              room_id: '12',
              room_number: '201',
              reasons: [{ code: 'WOULD_OVERBOOK', message: 'Would leave Deluxe oversold on 2027-10-12: 5 booked, 4 allowed after the change.' }],
            },
          ])
        );
        await renderLoaded();
        await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown rooms' }));
        await userEvent.click(screen.getAllByRole('button', { name: 'Change type' })[0]);
        await selectWhenLoaded('New room type', 'Standard (STD)');
        await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Change type' }));

        const panel = await screen.findByRole('alert');
        expect(panel).toHaveTextContent('Nothing was changed. 3 rooms are blocked:');
        expect(panel).toHaveTextContent('Room 101 — Room 101 is occupied by a checked-in guest.');
        // Two rooms blocked for the same reason read as ONE line naming both.
        expect(panel).toHaveTextContent('Rooms 102, 201 — Would leave Deluxe oversold');
        expect(screen.getByText('3 selected')).toBeInTheDocument();

        await userEvent.click(within(panel).getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
      });
    });

    describe('archive', () => {
      it('cannot be confirmed without a reason, then archives the room and reports the cleared links', async () => {
        mocks.bulkArchiveRooms.mockResolvedValue({
          changed: [ROOM_DLX_1],
          unchanged: [],
          cleared_preferences: [],
          cleared_connecting_links: [{ room_id: '10', room_number: '101' }],
        });
        await renderLoaded();
        await userEvent.click(within(rowFor('101')).getByRole('button', { name: 'Archive' }));

        const dialog = screen.getByRole('alertdialog');
        expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeDisabled();
        await userEvent.type(within(dialog).getByLabelText('Reason'), 'closed for refit');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

        expect(mocks.bulkArchiveRooms).toHaveBeenCalledWith({ room_ids: ['10'], reason: 'closed for refit' });
        const status = await screen.findByRole('status');
        expect(status).toHaveTextContent('Archived 1 room.');
        expect(status).toHaveTextContent('Removed the connecting-room link on 101.');
      });
    });

    describe('remove', () => {
      it('a room nothing references is deleted after a confirm with a reason', async () => {
        mocks.getRoomUsage.mockResolvedValue({ room_id: '12', room_number: '201', deletable: true, occupied: false, references: {} });
        mocks.deleteRoom.mockResolvedValue({ id: '12', deleted: true });
        await renderLoaded();
        await userEvent.click(within(rowFor('201')).getByRole('button', { name: 'Remove' }));

        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Delete room 201?');
        expect(dialog).toHaveTextContent('cannot be undone');
        await userEvent.type(within(dialog).getByLabelText('Reason'), 'created by mistake');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete room' }));

        expect(mocks.deleteRoom).toHaveBeenCalledWith('12', 'created by mistake');
        expect(await screen.findByRole('status')).toHaveTextContent('Deleted room 201. Its number can be used again.');
      });

      it('a room with history cannot be deleted: the dialog says why and offers to archive instead', async () => {
        mocks.getRoomUsage.mockResolvedValue({
          room_id: '10',
          room_number: '101',
          deletable: false,
          occupied: false,
          references: { reservation_rooms: 2, housekeeping_assignments: 1 },
        });
        mocks.bulkArchiveRooms.mockResolvedValue({ changed: [ROOM_DLX_1], unchanged: [], cleared_preferences: [], cleared_connecting_links: [] });
        await renderLoaded();
        await userEvent.click(within(rowFor('101')).getByRole('button', { name: 'Remove' }));

        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent("Room 101 can't be deleted");
        expect(dialog).toHaveTextContent('2 in reservation rooms');
        expect(dialog).toHaveTextContent('can only be archived');
        expect(mocks.deleteRoom).not.toHaveBeenCalled();

        await userEvent.type(within(dialog).getByLabelText('Reason'), 'retired');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Archive instead' }));
        expect(mocks.bulkArchiveRooms).toHaveBeenCalledWith({ room_ids: ['10'], reason: 'retired' });
        expect(mocks.deleteRoom).not.toHaveBeenCalled();
      });

      it('if the server finds history the preflight missed (a race), the blocked panel explains and nothing is deleted', async () => {
        mocks.getRoomUsage.mockResolvedValue({ room_id: '12', room_number: '201', deletable: true, occupied: false, references: {} });
        mocks.deleteRoom.mockRejectedValue(
          blockedError([{ room_id: '12', room_number: '201', reasons: [{ code: 'HAS_HISTORY', message: 'Room 201 has history so it cannot be deleted. Archive it instead.' }] }])
        );
        await renderLoaded();
        await userEvent.click(within(rowFor('201')).getByRole('button', { name: 'Remove' }));
        const dialog = await screen.findByRole('alertdialog');
        await userEvent.type(within(dialog).getByLabelText('Reason'), 'oops');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete room' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Room 201 — Room 201 has history so it cannot be deleted. Archive it instead.');
      });
    });

    describe('archived rooms', () => {
      it('the archived view lists archived rooms with only a Restore action, and restoring reloads', async () => {
        mocks.listRooms.mockImplementation(async (params) => (params?.status === 'archived' ? [{ ...ROOM_STD_1, status: 'archived' }] : [ROOM_DLX_1]));
        mocks.restoreRoom.mockResolvedValue({ ...ROOM_STD_1, status: 'active' });
        render(<RoomsTab disabled={false} />);
        await screen.findByText('101');

        await userEvent.click(screen.getByRole('button', { name: 'Show archived rooms' }));
        expect(await screen.findByText('201')).toBeInTheDocument();
        expect(mocks.listRooms).toHaveBeenCalledWith({ status: 'archived' });
        const row = within(rowFor('201'));
        expect(row.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
        expect(row.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: 'Select all shown rooms' })).not.toBeInTheDocument();

        await userEvent.click(row.getByRole('button', { name: 'Restore' }));
        expect(mocks.restoreRoom).toHaveBeenCalledWith('12');
        expect(await screen.findByRole('status')).toHaveTextContent('Restored room 201.');
      });

      it('a slow working-list response that lands AFTER switching to archived rooms cannot overwrite the archived list', async () => {
        let resolveWorking;
        const slowWorkingList = new Promise((resolve) => {
          resolveWorking = resolve;
        });
        mocks.listRooms
          .mockImplementationOnce(() => slowWorkingList) // the initial load, still in flight
          .mockResolvedValueOnce([{ ...ROOM_STD_1, status: 'archived' }]); // the archived view
        render(<RoomsTab disabled={false} />);

        await userEvent.click(screen.getByRole('button', { name: 'Show archived rooms' }));
        expect(await screen.findByText('201')).toBeInTheDocument();

        // The older, working-list response finally arrives.
        resolveWorking([ROOM_DLX_1, ROOM_DLX_2]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(screen.getByRole('heading', { name: /Archived rooms/ })).toBeInTheDocument();
        expect(screen.getByText('201')).toBeInTheDocument();
        expect(screen.queryByText('101')).not.toBeInTheDocument();
        expect(screen.queryByText('102')).not.toBeInTheDocument();
        // ...and none of those stale rows came with a working-list action next to an archived heading.
        expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
      });

      it('an empty archived view says so', async () => {
        mocks.listRooms.mockImplementation(async (params) => (params?.status === 'archived' ? [] : [ROOM_DLX_1]));
        render(<RoomsTab disabled={false} />);
        await screen.findByText('101');
        await userEvent.click(screen.getByRole('button', { name: 'Show archived rooms' }));
        expect(await screen.findByText('No archived rooms.')).toBeInTheDocument();
      });
    });

    describe('offline', () => {
      it('disables every change and says why', async () => {
        await renderLoaded({ isOffline: true });
        expect(screen.getByText(/You're offline/)).toBeInTheDocument();
        const row = within(rowFor('101'));
        for (const name of ['Edit', 'Change type', 'Archive', 'Remove']) {
          expect(row.getByRole('button', { name })).toBeDisabled();
        }
        expect(screen.getByRole('button', { name: 'Create rooms' })).toBeDisabled();
      });
    });

    it('a failed load leaves an error and an empty table, not a skeleton forever', async () => {
      mocks.listRooms.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Something went wrong.', status: 500 }));
      render(<RoomsTab disabled={false} />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    });
  });
});
