import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProductsImportPanel } from '../ProductsImportPanel.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  downloadProductsTemplate: vi.fn(),
  uploadProductsImport: vi.fn(),
  getProductsImport: vi.fn(),
  listProductsImports: vi.fn(),
  commitProductsImport: vi.fn(),
  rollbackProductsImport: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, supermarketApi: mocks };
});

const RUN = { id: '40', original_filename: 'mart.csv', status: 'dry_run_complete', rows_total: 2, rows_created: 2, created_at: '2027-11-01T10:00:00' };
const SUMMARY = { kind: 'predicted', products: 2, categoriesToCreate: 1, barcodes: 3, productsWithOpeningStock: 1, openingStockUnits: '48.000', errors: 0, warnings: 1 };
const WARNING = { id: '1', row_number: 2, column_name: 'barcodes', severity: 'warning', message: 'No barcode — this product cannot be scanned.' };
const ERROR = { id: '2', row_number: 3, column_name: 'category', severity: 'error', message: '"Drinks" is sold at Bar — use a supermarket category name such as "Mart Drinks".' };
const csvFile = () => new File(['name,category,price\nA,B,1.00\n'], 'mart.csv', { type: 'text/csv' });

async function uploadFile() {
  await userEvent.upload(screen.getByLabelText('CSV file'), csvFile());
  await userEvent.click(screen.getByRole('button', { name: 'Check file' }));
}

describe('<ProductsImportPanel>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listProductsImports.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('checks a file, shows what it will create and its warnings, and imports after confirming', async () => {
    mocks.uploadProductsImport.mockResolvedValue({ run: RUN, errors: [WARNING], summary: SUMMARY });
    mocks.commitProductsImport.mockResolvedValue({ ...RUN, status: 'committing' });
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await uploadFile();

    expect(mocks.uploadProductsImport).toHaveBeenCalledWith({ outletId: '5', file: expect.any(File) });
    const stats = await screen.findByLabelText('What this file will create');
    expect(within(stats).getByText('48.000 units')).toBeInTheDocument();
    expect(screen.getByText(/Warnings \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('No barcode — this product cannot be scanned.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Import 2 products' }));
    expect(screen.getByText('Import 2 products into Mini Mart?')).toBeInTheDocument();
    expect(screen.getByText(/48.000 units of opening stock are received into Mini Mart/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(mocks.commitProductsImport).toHaveBeenCalledWith('40');
    expect(await screen.findByText('Importing…')).toBeInTheDocument();
  });

  it('offers no Import while the dry run has errors, and lists them', async () => {
    mocks.uploadProductsImport.mockResolvedValue({ run: RUN, errors: [ERROR, WARNING], summary: { ...SUMMARY, errors: 1 } });
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await uploadFile();
    expect(await screen.findByText(/Problems to fix \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(ERROR.message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
  });

  it('shows the server refusing a file that is not the template', async () => {
    mocks.uploadProductsImport.mockRejectedValue(new ApiError({ code: 'VALIDATION_PRODUCT_IMPORT_FILE', message: 'This is not the product import template (unknown column(s): barcode).', status: 400 }));
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await uploadFile();
    expect(await screen.findByRole('alert')).toHaveTextContent('unknown column(s): barcode');
  });

  it('polls a running import until it finishes, then shows what it created', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.uploadProductsImport.mockResolvedValue({ run: RUN, errors: [], summary: SUMMARY });
    mocks.commitProductsImport.mockResolvedValue({ ...RUN, status: 'committing' });
    mocks.getProductsImport
      .mockResolvedValueOnce({ run: { ...RUN, status: 'committing' }, errors: [], summary: { kind: 'imported', products: 0, categoriesCreated: 0 } })
      .mockResolvedValue({ run: { ...RUN, status: 'completed' }, errors: [], summary: { kind: 'imported', products: 2, categoriesCreated: 1 } });
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await uploadFile();
    await userEvent.click(await screen.findByRole('button', { name: 'Import 2 products' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await act(async () => vi.advanceTimersByTimeAsync(2100));
    await act(async () => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText('Imported')).toBeInTheDocument();
    expect(within(screen.getByLabelText('What this import created')).getByText('2')).toBeInTheDocument();
    const calls = mocks.getProductsImport.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(mocks.getProductsImport.mock.calls.length).toBe(calls);
  });

  it('drops a slow poll answer that arrives after "Start again"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer;
    mocks.uploadProductsImport.mockResolvedValue({ run: RUN, errors: [], summary: SUMMARY });
    mocks.commitProductsImport.mockResolvedValue({ ...RUN, status: 'committing' });
    mocks.getProductsImport.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await uploadFile();
    await userEvent.click(await screen.findByRole('button', { name: 'Import 2 products' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await act(async () => vi.advanceTimersByTimeAsync(2100)); // the poll is now in flight
    await userEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await act(async () => answer({ run: { ...RUN, status: 'completed' }, errors: [], summary: { kind: 'imported', products: 2, categoriesCreated: 1 } }));
    expect(screen.queryByText('Imported')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check file' })).toBeInTheDocument();
  });

  it('shows why a commit failed', async () => {
    mocks.listProductsImports.mockResolvedValue([{ ...RUN, status: 'failed' }]);
    mocks.getProductsImport.mockResolvedValue({ run: { ...RUN, status: 'failed', failed_reason: 'The data changed since the dry run: 1 problem(s).' }, errors: [ERROR], summary: { kind: 'imported', products: 0, categoriesCreated: 0 } });
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The data changed since the dry run');
    expect(screen.getByText(ERROR.message)).toBeInTheDocument();
  });

  it('undoes a past import only with a reason, and lists the products it kept', async () => {
    mocks.listProductsImports.mockResolvedValue([{ ...RUN, status: 'completed' }]);
    mocks.rollbackProductsImport.mockResolvedValue({ status: 'partially_rolled_back', rowsRolledBack: 1, rowsRefused: [{ entityType: 'product', entityId: '9', rowNumber: 2, name: 'Coke 50cl', reason: 'It has been sold at the till since the import.' }] });
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    const confirm = screen.getByRole('button', { name: 'Undo import' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), 'Wrong price list');
    await userEvent.click(confirm);
    expect(mocks.rollbackProductsImport).toHaveBeenCalledWith('40', 'Wrong price list');
    const kept = await screen.findByLabelText('Kept after undo');
    expect(kept).toHaveTextContent('Coke 50cl');
    expect(kept).toHaveTextContent('sold at the till');
  });

  it('offers no Undo for a run that is not imported', async () => {
    mocks.listProductsImports.mockResolvedValue([{ ...RUN, status: 'rolled_back' }, { ...RUN, id: '41', status: 'failed' }]);
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    expect(await screen.findAllByRole('button', { name: 'View' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('disables checking, importing and undo while offline', async () => {
    mocks.listProductsImports.mockResolvedValue([{ ...RUN, status: 'completed' }]);
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" isOffline />);
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download template' })).toBeDisabled();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
  });

  it("drops one outlet's slow history and upload once another outlet is shown", async () => {
    let slowHistory;
    let slowUpload;
    mocks.listProductsImports.mockImplementation((outletId) => (outletId === '5' ? new Promise((resolve) => (slowHistory = resolve)) : Promise.resolve([])));
    mocks.uploadProductsImport.mockReturnValue(new Promise((resolve) => (slowUpload = resolve)));
    const { rerender } = render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await uploadFile();
    rerender(<ProductsImportPanel outletId="6" outletName="Second Mart" />);
    await act(async () => {
      slowHistory([{ ...RUN, original_filename: 'old-outlet.csv', status: 'completed' }]);
      slowUpload({ run: { ...RUN, original_filename: 'old-outlet.csv' }, errors: [], summary: SUMMARY });
    });
    expect(await screen.findByText('No imports yet.')).toBeInTheDocument();
    expect(screen.queryByText('old-outlet.csv')).not.toBeInTheDocument();
  });

  it('gives the real totals when the server sends only the first few hundred findings', async () => {
    mocks.uploadProductsImport.mockResolvedValue({ run: RUN, errors: [WARNING], findingCounts: { errors: 0, warnings: 4000, shownPerKind: 300 }, summary: SUMMARY });
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    await uploadFile();
    expect(await screen.findByText(/Warnings \(4000, first 1 shown\)/)).toBeInTheDocument();
  });

  it('shows a history load failure', async () => {
    mocks.listProductsImports.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Server unavailable', status: 500 }));
    render(<ProductsImportPanel outletId="5" outletName="Mini Mart" />);
    expect(await screen.findByText('Server unavailable')).toBeInTheDocument();
  });
});
