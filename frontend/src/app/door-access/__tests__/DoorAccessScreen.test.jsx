import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DoorAccessScreen } from '../DoorAccessScreen.jsx';
import { ImportTab } from '../ImportTab.jsx';
import { AlertsTab } from '../AlertsTab.jsx';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  readHeaders: vi.fn(),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
  listAlerts: vi.fn(),
  getAlert: vi.fn(),
  acknowledgeAlert: vi.fn(),
  resolveAlert: vi.fn(),
  listStayConfirmations: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, doorAccessApi: { ...actual.doorAccessApi, ...mocks } };
});

const CONFIG = {
  id: '1',
  adapter: 'hiread_prousb',
  ingestionMode: 'manual_import',
  postCheckoutGraceMinutes: 15,
  importMapping: null,
  lastImportAt: '2026-09-10T08:30:00.000Z',
  supportsRealtime: false,
  timezone: 'Africa/Lagos',
};

const ALERT = {
  id: '7',
  room_number: '101',
  card_id: 'CARD-X',
  rule: 'unsold_occupancy',
  severity: 'critical',
  status: 'open',
  event_count: 2,
  first_event_at: '2026-09-01T22:05:00.000Z',
  last_event_at: '2026-09-02T00:30:00.000Z',
  evidence: { retrospective: true, previousStay: null, roomAtDetection: { roomNumber: '101', frontDeskStatus: 'vacant', housekeepingStatus: 'clean', hasDiscrepancy: false } },
};

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.getConfig.mockResolvedValue(CONFIG);
  mocks.listAlerts.mockResolvedValue([]);
  mocks.listStayConfirmations.mockResolvedValue([]);
});

describe('<DoorAccessScreen>', () => {
  it('states on every tab that detection is retrospective, with the last import date, and offers no way to dismiss it', async () => {
    const user = userEvent.setup();
    render(<DoorAccessScreen />);

    const banner = await screen.findByRole('note', { name: /detection is retrospective/i });
    expect(banner).toHaveTextContent(/not live monitoring/i);
    expect(banner).toHaveTextContent(/10 Sept 2026|10 Sep 2026/);
    expect(within(banner).queryByRole('button')).toBeNull();

    for (const name of ['Import lock log', 'Stay confirmations', 'Settings', 'Alerts']) {
      await user.click(screen.getByRole('tab', { name }));
      expect(screen.getByRole('note', { name: /detection is retrospective/i })).toBeInTheDocument();
    }
  });

  it('says "never" when no lock log has been imported, and the empty inbox does not imply nothing happened', async () => {
    mocks.getConfig.mockResolvedValue({ ...CONFIG, lastImportAt: null });
    render(<DoorAccessScreen />);
    expect(await screen.findByRole('note', { name: /detection is retrospective/i })).toHaveTextContent(/Last lock log import: never/);
    expect(await screen.findByText(/no alerts does not mean no activity since the last import/i)).toBeInTheDocument();
  });

  it('shows the real load error instead of a blank screen', async () => {
    const { ApiError } = await vi.importActual('../../../shared/api/index.js');
    mocks.getConfig.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PLAN_ENTITLEMENT', message: 'Your current plan does not include this feature.' }));
    render(<DoorAccessScreen />);
    expect(await screen.findByText('Your current plan does not include this feature.')).toBeInTheDocument();
  });
});

describe('<ImportTab>', () => {
  const HEADERS = {
    headers: ['Lock', 'Card No', 'Kind', 'Open Time'],
    rowCount: 3,
    distinctValues: { Kind: { values: ['Guest', 'Master'], truncated: false }, Lock: { values: [], truncated: false }, 'Card No': { values: [], truncated: false }, 'Open Time': { values: [], truncated: false } },
    savedMapping: null,
    timestampFormats: ['DD/MM/YYYY HH:mm:ss', 'MM/DD/YYYY HH:mm:ss', 'YYYY-MM-DD HH:mm:ss'],
  };
  const PREVIEW = {
    newEventCount: 2,
    duplicatesInFile: 1,
    duplicatesAlreadyImported: 0,
    unmatchedRoomRowCount: 1,
    unmatchedRooms: [{ identifier: '9999', count: 1 }],
    unparseableCount: 0,
    unparseableRows: [],
    guestEventCount: 1,
    nonGuestEventCount: 1,
    deniedEventCount: 0,
    earliestEventAt: '2026-09-01T22:05:00.000Z',
    latestEventAt: '2026-09-02T00:30:00.000Z',
    sampleEvents: [{ rowNumber: 2, roomNumber: '101', cardId: 'C1', cardType: 'Guest', openedAt: '2026-09-01T22:05:00.000Z', result: 'granted' }],
  };

  async function uploadAndMap(user) {
    await user.upload(screen.getByLabelText(/lock audit-trail file/i), new File(['x'], 'audit.xls', { type: 'application/vnd.ms-excel' }));
    await user.click(screen.getByRole('button', { name: 'Read columns' }));
    await screen.findByText('2. Match the columns');
    await user.selectOptions(screen.getByLabelText('Room or lock number'), 'Lock');
    await user.selectOptions(screen.getByLabelText('Card ID'), 'Card No');
    await user.selectOptions(screen.getByLabelText('Date and time opened'), 'Open Time');
  }

  it('offers the file\'s real columns, warns without a card-type column, previews, and imports exactly the mapping previewed', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    mocks.readHeaders.mockResolvedValue(HEADERS);
    mocks.previewImport.mockResolvedValue(PREVIEW);
    mocks.commitImport.mockResolvedValue({ eventsStored: 2, criticalAlertsCreated: 1, alertsExtended: 0, stayConfirmationsRecorded: 0, notifiedRecipientCount: 2, earliestEventAt: PREVIEW.earliestEventAt, latestEventAt: PREVIEW.latestEventAt });
    render(<ImportTab config={CONFIG} onImported={onImported} onOpenSettings={vi.fn()} />);

    await uploadAndMap(user);
    expect(screen.getAllByRole('option', { name: 'Open Time' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/every card will be treated as a guest card/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Card type (optional)'), 'Kind');
    expect(screen.getByRole('button', { name: 'Preview import' })).toBeDisabled(); // must tick at least one guest value
    await user.click(screen.getByRole('checkbox', { name: 'Guest' }));
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByText('9999')).toBeInTheDocument();
    expect(screen.getByText('New door openings').nextSibling).toHaveTextContent('2');

    await user.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/cannot be edited or deleted/i);
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    expect(await screen.findByText(/raised retrospectively/i)).toBeInTheDocument();
    const expectedMapping = {
      roomColumn: 'Lock',
      cardColumn: 'Card No',
      timestampColumn: 'Open Time',
      timestampFormat: null,
      cardTypeColumn: 'Kind',
      guestCardTypeValues: ['Guest'],
      resultColumn: null,
      deniedResultValues: [],
    };
    expect(mocks.previewImport).toHaveBeenCalledWith(expect.any(File), expectedMapping);
    expect(mocks.commitImport).toHaveBeenCalledWith(expect.any(File), expectedMapping);
    expect(onImported).toHaveBeenCalled();
  });

  it('changing the mapping after a preview discards the preview', async () => {
    const user = userEvent.setup();
    mocks.readHeaders.mockResolvedValue(HEADERS);
    mocks.previewImport.mockResolvedValue(PREVIEW);
    render(<ImportTab config={CONFIG} onImported={vi.fn()} onOpenSettings={vi.fn()} />);
    await uploadAndMap(user);
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText('3. Check and import');
    await user.selectOptions(screen.getByLabelText(/how the date and time are written/i), 'DD/MM/YYYY HH:mm:ss');
    expect(screen.queryByText('3. Check and import')).toBeNull();
  });

  it('drops a preview that returns after the mapping changed, so Import can never confirm an unpreviewed mapping (code-review regression)', async () => {
    const user = userEvent.setup();
    let resolvePreview;
    mocks.readHeaders.mockResolvedValue(HEADERS);
    mocks.previewImport.mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve; }));
    render(<ImportTab config={CONFIG} onImported={vi.fn()} onOpenSettings={vi.fn()} />);
    await uploadAndMap(user);
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.selectOptions(screen.getByLabelText(/how the date and time are written/i), 'DD/MM/YYYY HH:mm:ss');
    resolvePreview(PREVIEW);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview import' })).not.toBeDisabled());
    expect(screen.queryByText('3. Check and import')).toBeNull();
  });

  it('locks the file picker while a request is in flight', async () => {
    const user = userEvent.setup();
    mocks.readHeaders.mockImplementation(() => new Promise(() => {}));
    render(<ImportTab config={CONFIG} onImported={vi.fn()} onOpenSettings={vi.fn()} />);
    await user.upload(screen.getByLabelText(/lock audit-trail file/i), new File(['x'], 'a.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: 'Read columns' }));
    expect(screen.getByLabelText(/lock audit-trail file/i)).toBeDisabled();
  });

  it('points to Settings while no lock system is chosen', async () => {
    const onOpenSettings = vi.fn();
    render(<ImportTab config={{ ...CONFIG, adapter: 'none' }} onImported={vi.fn()} onOpenSettings={onOpenSettings} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('disables reading and importing while offline', async () => {
    render(<ImportTab config={CONFIG} isOffline onImported={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText(/importing is disabled/i)).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText(/lock audit-trail file/i), new File(['x'], 'audit.csv', { type: 'text/csv' }));
    expect(screen.getByRole('button', { name: 'Read columns' })).toBeDisabled();
  });
});

describe('<AlertsTab>', () => {
  it('lists alerts with a retrospective age pill and resolves only with a reason', async () => {
    const user = userEvent.setup();
    mocks.listAlerts.mockResolvedValue([ALERT]);
    mocks.getAlert.mockResolvedValueOnce({ ...ALERT, events: [], roomTimeline: [{ id: '1', opened_at: ALERT.first_event_at, card_id: 'CARD-X', card_type: null, result: 'granted' }] });
    mocks.getAlert.mockResolvedValueOnce({ ...ALERT, status: 'resolved', resolution_reason: 'Walk-in not entered', events: [], roomTimeline: [] });
    mocks.resolveAlert.mockResolvedValue({ ...ALERT, status: 'resolved' });
    render(<AlertsTab config={CONFIG} />);

    expect(await screen.findByText('Critical')).toBeInTheDocument();
    expect(screen.getAllByText(/Retrospective — occurred \d+ days? ago/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'View evidence' }));
    expect(await screen.findByText(/found when a lock log was uploaded, not as it happened/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Resolve alert' })).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'Walk-in not entered');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve alert' }));

    await waitFor(() => expect(mocks.resolveAlert).toHaveBeenCalledWith('7', 'Walk-in not entered'));
    expect(await screen.findByText('Walk-in not entered')).toBeInTheDocument();
  });

  it('keeps the filters reachable when there are no alerts', async () => {
    const user = userEvent.setup();
    render(<AlertsTab config={CONFIG} />);
    await screen.findByText(/no open alerts/i);
    await user.selectOptions(screen.getByLabelText('Status'), 'resolved');
    expect(mocks.listAlerts).toHaveBeenLastCalledWith({ status: 'resolved', rule: '' });
  });
});
