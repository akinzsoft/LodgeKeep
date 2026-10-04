import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BarcodesCard } from '../BarcodesCard.jsx';
import { ApiError } from '../../../shared/api/index.js';

const api = vi.hoisted(() => ({ listBarcodes: vi.fn(), addBarcode: vi.fn(), removeBarcode: vi.fn() }));
vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, supermarketApi: api };
});
const scanner = vi.hoisted(() => ({
  describeCamera: vi.fn(() => null),
  decoderInfo: vi.fn(() => ({ state: 'ready', loadMs: 1, wasmUrl: '/assets/x.wasm', error: null })),
  listCameras: vi.fn(async () => []),
  lastFrame: vi.fn(() => null),
  openCamera: vi.fn(),
  closeCamera: vi.fn(),
  loadDetector: vi.fn(),
  readFrame: vi.fn(),
  torchSupported: vi.fn(() => false),
  setTorch: vi.fn(),
  newScanStats: () => ({ notReady: 0, attempts: 0, completed: 0, empty: 0, errors: 0, consecutiveErrors: 0, lastError: null, lastMs: null, lastCode: null, frameSize: null, inFlightSince: null }),
}));
vi.mock('../../../shared/scanner/cameraScanner.js', () => scanner);
vi.mock('../../../shared/sound/alertBeep.js', () => ({ playScanTone: vi.fn() }));

const ROWS = [
  { id: '1', menu_item_id: '10', barcode: '6001000000011', item_name: 'Rice 5kg', item_status: 'active', on_till: true },
  { id: '2', menu_item_id: '10', barcode: '6001000000028', item_name: 'Rice 5kg', item_status: 'active', on_till: true },
  { id: '3', menu_item_id: '20', barcode: 'e', item_name: 'EGUISI SOUP', item_status: 'active', on_till: false },
  { id: '4', menu_item_id: '30', barcode: '999', item_name: 'Old soap', item_status: 'archived', on_till: false },
];

function renderCard(props = {}) {
  return render(<BarcodesCard outletId="5" {...props} />);
}

describe('<BarcodesCard>', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    Object.values(scanner).forEach((fn) => fn.mockReset?.());
    api.listBarcodes.mockResolvedValue(ROWS);
  });

  it('lists every barcode grouped by product, with whether the product is on this till', async () => {
    renderCard();
    const rice = await screen.findByRole('list', { name: 'Barcodes for Rice 5kg' });
    expect(within(rice).getByText('6001000000011')).toBeInTheDocument();
    expect(within(rice).getByText('6001000000028')).toBeInTheDocument();
    expect(api.listBarcodes).toHaveBeenCalledWith('5');
    // A product's row is the parent of its barcode list.
    expect(within(screen.getByRole('list', { name: 'Barcodes for EGUISI SOUP' }).parentElement).getByText('Not on this till')).toBeInTheDocument();
    expect(within(rice.parentElement).getByText('On this till')).toBeInTheDocument();
    // An archived product: its barcode can still be removed, but nothing added.
    expect(screen.getByText('Archived product')).toBeInTheDocument();
    expect(screen.queryByLabelText('Another barcode for Old soap')).not.toBeInTheDocument();
  });

  it('filters by product name or barcode', async () => {
    renderCard();
    await screen.findByRole('list', { name: 'Barcodes for Rice 5kg' });
    await userEvent.type(screen.getByLabelText('Search barcodes or products'), 'egu');
    expect(screen.queryByRole('list', { name: 'Barcodes for Rice 5kg' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Barcodes for EGUISI SOUP' })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search barcodes or products'));
    await userEvent.type(screen.getByLabelText('Search barcodes or products'), '0028');
    expect(screen.getByRole('list', { name: 'Barcodes for Rice 5kg' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Barcodes for EGUISI SOUP' })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search barcodes or products'));
    await userEvent.type(screen.getByLabelText('Search barcodes or products'), 'zzz');
    expect(screen.getByText('No barcode or product matches “zzz”.')).toBeInTheDocument();
  });

  it('removes a barcode only after a confirm, then reloads and tells the tab', async () => {
    const onChanged = vi.fn();
    api.removeBarcode.mockResolvedValue({ id: '3' });
    renderCard({ onChanged });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove barcode e from EGUISI SOUP' }));
    expect(screen.getByText('Scanning e will no longer find EGUISI SOUP. The product, its sales and its stock are not changed.')).toBeInTheDocument();
    expect(api.removeBarcode).not.toHaveBeenCalled();
    api.listBarcodes.mockResolvedValue(ROWS.filter((row) => row.id !== '3'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove barcode' }));
    expect(api.removeBarcode).toHaveBeenCalledWith('3');
    await vi.waitFor(() => expect(screen.queryByRole('list', { name: 'Barcodes for EGUISI SOUP' })).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalled();
  });

  it('cancelling the confirm removes nothing', async () => {
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove barcode e from EGUISI SOUP' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.removeBarcode).not.toHaveBeenCalled();
    expect(screen.getByRole('list', { name: 'Barcodes for EGUISI SOUP' })).toBeInTheDocument();
  });

  it('adds another barcode to a product that already has one, and shows a refused duplicate', async () => {
    const onChanged = vi.fn();
    api.addBarcode.mockResolvedValueOnce({ id: '5' });
    renderCard({ onChanged });
    const field = await screen.findByLabelText('Another barcode for Rice 5kg');
    await userEvent.type(field, '6001000000042');
    api.listBarcodes.mockResolvedValue([...ROWS, { id: '5', menu_item_id: '10', barcode: '6001000000042', item_name: 'Rice 5kg', item_status: 'active', on_till: true }]);
    await userEvent.click(within(field.closest('form')).getByRole('button', { name: 'Add' }));
    expect(api.addBarcode).toHaveBeenCalledWith('10', '6001000000042');
    expect(await within(screen.getByRole('list', { name: 'Barcodes for Rice 5kg' })).findByText('6001000000042')).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(onChanged).toHaveBeenCalled();

    api.addBarcode.mockRejectedValueOnce(new ApiError({ code: 'CONFLICT_BARCODE_ALREADY_USED', message: 'Barcode e is already used by another product.', status: 409 }));
    await userEvent.type(screen.getByLabelText('Another barcode for Rice 5kg'), 'e');
    await userEvent.click(within(screen.getByLabelText('Another barcode for Rice 5kg').closest('form')).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Barcode e is already used by another product.');
  });

  it('scans another barcode into the product\'s field with the camera, and saves only on Add', async () => {
    scanner.openCamera.mockResolvedValue({ id: 'stream' });
    scanner.loadDetector.mockResolvedValue({ detect: vi.fn() });
    scanner.readFrame.mockResolvedValueOnce('6001000000059').mockResolvedValue(null);
    renderCard({ canUseCamera: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Scan another barcode for Rice 5kg' }));
    expect(await screen.findByRole('dialog', { name: 'Scan another barcode for Rice 5kg' })).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 3000 });
    const field = screen.getByLabelText('Another barcode for Rice 5kg');
    expect(field).toHaveValue('6001000000059');
    await waitFor(() => expect(field).toHaveFocus());
    expect(api.addBarcode).not.toHaveBeenCalled();
  });

  it('disables Remove, Add and Scan offline, and says when there are no barcodes or the list failed', async () => {
    renderCard({ isOffline: true, canUseCamera: true });
    expect(await screen.findByRole('button', { name: 'Remove barcode e from EGUISI SOUP' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Scan another barcode for Rice 5kg' })).toBeDisabled();
    expect(screen.getByLabelText('Another barcode for Rice 5kg')).toBeDisabled();
  });

  it('reports a failed load, and an empty property', async () => {
    api.listBarcodes.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL', message: 'Server unavailable', status: 500 }));
    const { unmount } = renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    unmount();
    api.listBarcodes.mockResolvedValue([]);
    renderCard();
    expect(await screen.findByText('No barcodes yet. Add them under “Products needing setup”, or with Products import.')).toBeInTheDocument();
  });

  it('reloads when the tab says barcodes changed elsewhere', async () => {
    const { rerender } = renderCard({ refreshKey: 0 });
    await screen.findByRole('list', { name: 'Barcodes for Rice 5kg' });
    expect(api.listBarcodes).toHaveBeenCalledTimes(1);
    await act(async () => rerender(<BarcodesCard outletId="5" refreshKey={1} />));
    expect(api.listBarcodes).toHaveBeenCalledTimes(2);
  });
});
