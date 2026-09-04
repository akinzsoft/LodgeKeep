import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaxesTab } from '../TaxesTab.jsx';

const mocks = vi.hoisted(() => ({
  listTaxes: vi.fn(),
  createTaxVersion: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { listTaxes: mocks.listTaxes, createTaxVersion: mocks.createTaxVersion },
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
    render(<TaxesTab disabled={false} />);
    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Historical')).toBeInTheDocument();
  });

  it('does not save on submit alone — a confirmation step is required first (DESIGN_SYSTEM.md §2)', async () => {
    render(<TaxesTab disabled={false} />);
    await screen.findByText(/no taxes configured yet/i);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Save tax version' }));

    expect(mocks.createTaxVersion).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/applies going forward only/i)).toBeInTheDocument();
  });

  it('the Confirm button stays disabled until a reason is typed (requireReason)', async () => {
    render(<TaxesTab disabled={false} />);
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
    render(<TaxesTab disabled={false} />);
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
    render(<TaxesTab disabled={false} />);
    await screen.findByText(/no taxes configured yet/i);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Save tax version' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mocks.createTaxVersion).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
