import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaxesTab } from '../TaxesTab.jsx';

const mocks = vi.hoisted(() => ({
  listTaxes: vi.fn(),
  createTaxVersion: vi.fn(),
  deactivateTax: vi.fn(),
  reactivateTax: vi.fn(),
  deleteTax: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { listTaxes: mocks.listTaxes, createTaxVersion: mocks.createTaxVersion, deactivateTax: mocks.deactivateTax, reactivateTax: mocks.reactivateTax, deleteTax: mocks.deleteTax },
  };
});

async function fillForm() {
  // Tax code and Name both use placeholder "VAT" — two distinct fields.
  const [taxCodeInput, nameInput] = screen.getAllByPlaceholderText('VAT');
  await userEvent.type(taxCodeInput, 'VAT');
  await userEvent.type(nameInput, 'VAT');
  await userEvent.type(screen.getByPlaceholderText('7.5000'), '10.0000');
  const dateInput = document.querySelector('input[type="date"]');
  await userEvent.type(dateInput, '2026-06-01');
}

describe('<TaxesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listTaxes.mockResolvedValue([]);
  });

  it('shows current vs historical versions as status pills, not colour alone', async () => {
    mocks.listTaxes.mockResolvedValue([
      { id: '1', tax_code: 'VAT', name: 'VAT', rate: '7.5000', calculation_method: 'percentage', effective_from: '2026-01-01', effective_to: '2026-05-31' },
      { id: '2', tax_code: 'VAT', name: 'VAT', rate: '10.0000', calculation_method: 'percentage', effective_from: '2026-06-01', effective_to: null },
    ]);
    render(<TaxesTab canManage disabled={false} />);
    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Historical')).toBeInTheDocument();
  });

  it('does not save on submit alone — a confirmation step is required first (DESIGN_SYSTEM.md §2)', async () => {
    render(<TaxesTab canManage disabled={false} />);
    await screen.findByText(/no taxes configured yet/i);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Save tax version' }));

    expect(mocks.createTaxVersion).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/applies going forward only/i)).toBeInTheDocument();
  });

  it('the Confirm button stays disabled until a reason is typed (requireReason)', async () => {
    render(<TaxesTab canManage disabled={false} />);
    await screen.findByText(/no taxes configured yet/i);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Save tax version' }));

    const confirmButton = screen.getByRole('button', { name: /confirm change/i });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Government VAT rate increase');
    expect(confirmButton).not.toBeDisabled();
  });

  it('submits with the typed reason, which reaches the API call directly (feeds the audit trail)', async () => {
    mocks.createTaxVersion.mockResolvedValue({ id: '3' });
    render(<TaxesTab canManage disabled={false} />);
    await screen.findByText(/no taxes configured yet/i);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Save tax version' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'Government VAT rate increase');
    await userEvent.click(screen.getByRole('button', { name: /confirm change/i }));

    expect(mocks.createTaxVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        tax_code: 'VAT',
        rate: '10.0000',
        effective_from: '2026-06-01',
        reason: 'Government VAT rate increase',
      })
    );
  });

  it('cancelling the confirmation does not call the API', async () => {
    render(<TaxesTab canManage disabled={false} />);
    await screen.findByText(/no taxes configured yet/i);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Save tax version' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mocks.createTaxVersion).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('sends who a tax applies to: "all" by default, and supermarket sales only when chosen', async () => {
    mocks.createTaxVersion.mockResolvedValue({});
    const submit = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Save tax version' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByLabelText(/reason/i), 'Set up');
      await userEvent.click(within(dialog).getByRole('button', { name: /confirm/i }));
    };
    render(<TaxesTab canManage disabled={false} />);
    await screen.findByText(/no taxes configured yet/i);

    await fillForm();
    await submit();
    expect(mocks.createTaxVersion).toHaveBeenLastCalledWith(expect.objectContaining({ applies_to: 'all' }));

    await fillForm();
    await userEvent.selectOptions(screen.getByLabelText('Applies to'), 'supermarket_sale');
    await submit();
    expect(mocks.createTaxVersion).toHaveBeenLastCalledWith(expect.objectContaining({ applies_to: 'supermarket_sale' }));
  });

  describe('deactivate and delete', () => {
    const VAT_ROWS = [
      { id: '2', tax_code: 'VAT', name: 'VAT', rate: '10.0000', calculation_method: 'percentage', effective_from: '2026-06-01', effective_to: null },
      { id: '1', tax_code: 'VAT', name: 'VAT', rate: '7.5000', calculation_method: 'percentage', effective_from: '2026-01-01', effective_to: '2026-05-31' },
    ];
    const property = { current_business_date: '2026-10-10' };

    it('offers the actions once per tax, on its newest version only, and Deactivate only while it is open', async () => {
      mocks.listTaxes.mockResolvedValue(VAT_ROWS);
      render(<TaxesTab canManage disabled={false} activeProperty={property} />);
      await screen.findByText('Current');
      expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Deactivate' })).toHaveLength(1);
    });

    it('deactivate needs a reason and sends the business date by default, then reloads', async () => {
      mocks.listTaxes.mockResolvedValue(VAT_ROWS);
      mocks.deactivateTax.mockResolvedValue({});
      render(<TaxesTab canManage disabled={false} activeProperty={property} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByDisplayValue('2026-10-10')).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
      expect(mocks.deactivateTax).not.toHaveBeenCalled();
      await userEvent.type(within(dialog).getByRole('textbox'), 'Not charged any more');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
      expect(mocks.deactivateTax).toHaveBeenCalledWith('VAT', { reason: 'Not charged any more' });
      expect(mocks.listTaxes).toHaveBeenCalledTimes(2);
    });

    it('delete sends the reason; a refusal shows the server message with the counts', async () => {
      mocks.listTaxes.mockResolvedValue(VAT_ROWS);
      const { ApiError } = await import('../../../shared/api/index.js');
      mocks.deleteTax.mockRejectedValue(new ApiError({ status: 409, code: 'CONFLICT_TAX_IN_USE', message: 'Tax "VAT" cannot be deleted: 3 records. Deactivate it instead.' }));
      render(<TaxesTab canManage disabled={false} activeProperty={property} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      const dialog = screen.getByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'Mistake');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete tax' }));
      expect(mocks.deleteTax).toHaveBeenCalledWith('VAT', { reason: 'Mistake' });
      expect(await screen.findByRole('alert')).toHaveTextContent(/Deactivate it instead/);
    });

    it('both actions are disabled while offline', async () => {
      mocks.listTaxes.mockResolvedValue(VAT_ROWS);
      render(<TaxesTab canManage disabled={false} isOffline activeProperty={property} />);
      await screen.findByText('Current');
      expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
    });
  });
  describe('tax.manage gating, reactivate and the VAT-off banner', () => {
    const property = { current_business_date: '2026-10-10' };
    const OPEN = [{ id: '2', tax_code: 'VAT', name: 'VAT', rate: '7.5000', calculation_method: 'percentage', applies_to: 'all', effective_from: '2026-01-01', effective_to: null }];
    const OFF = [{ id: '2', tax_code: 'VAT', name: 'VAT', rate: '7.5000', calculation_method: 'percentage', applies_to: 'all', effective_from: '2026-01-01', effective_to: '2026-10-05' }];

    it('a non-holder sees the list and a note, but no create form and no action buttons', async () => {
      mocks.listTaxes.mockResolvedValue(OPEN);
      render(<TaxesTab disabled={false} activeProperty={property} />);
      await screen.findByText('Current');
      expect(screen.queryByRole('button', { name: 'Save tax version' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
      expect(screen.getByText(/Only a super admin/)).toBeInTheDocument();
    });

    it('shows "VAT is off: new bills carry no tax" only when the hotel tax has no live version', async () => {
      mocks.listTaxes.mockResolvedValue(OFF);
      const { unmount } = render(<TaxesTab canManage disabled={false} activeProperty={property} />);
      expect(await screen.findByText('VAT is off: new bills carry no tax')).toBeInTheDocument();
      unmount();
      mocks.listTaxes.mockResolvedValue(OPEN);
      render(<TaxesTab canManage disabled={false} activeProperty={property} />);
      await screen.findByText('Current');
      expect(screen.queryByText(/is off: new bills carry no tax/)).not.toBeInTheDocument();
    });

    it('the banner also shows for a non-holder', async () => {
      mocks.listTaxes.mockResolvedValue(OFF);
      render(<TaxesTab disabled={false} activeProperty={property} />);
      expect(await screen.findByText('VAT is off: new bills carry no tax')).toBeInTheDocument();
    });

    it('Reactivate replaces Deactivate on an inactive tax and sends the reason', async () => {
      mocks.listTaxes.mockResolvedValue(OFF);
      mocks.reactivateTax.mockResolvedValue({});
      render(<TaxesTab canManage disabled={false} activeProperty={property} />);
      expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
      await userEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
      const dialog = screen.getByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'Back on');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }));
      expect(mocks.reactivateTax).toHaveBeenCalledWith('VAT', { reason: 'Back on' });
    });
  });
});
