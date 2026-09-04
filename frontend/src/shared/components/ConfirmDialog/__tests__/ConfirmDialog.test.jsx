import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '../ConfirmDialog.jsx';

describe('<ConfirmDialog>', () => {
  it('states the consequence in plain words (DESIGN_SYSTEM.md §2)', () => {
    render(
      <ConfirmDialog
        title="Void this charge?"
        consequence="This will remove the charge from the folio and cannot be undone."
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(
      screen.getByText('This will remove the charge from the folio and cannot be undone.')
    ).toBeInTheDocument();
  });

  it('announces as an alert dialog for assistive tech', () => {
    render(<ConfirmDialog title="Cancel booking?" consequence="c" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('calls onConfirm with no reason when requireReason is not set', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Cancel booking?" consequence="c" onConfirm={onConfirm} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('requires a reason for a money operation before Confirm is enabled (SECURITY.md §1.1)', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Refund this payment?"
        consequence="This posts a refund to the guest's original payment method."
        requireReason
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Guest cancelled within policy window');
    expect(confirmButton).toBeEnabled();

    await userEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith('Guest cancelled within policy window');
  });

  it('does not accept a whitespace-only reason as a real one', async () => {
    render(
      <ConfirmDialog title="Refund" consequence="c" requireReason onConfirm={() => {}} onCancel={() => {}} />
    );
    await userEvent.type(screen.getByLabelText('Reason'), '   ');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('calls onCancel from the cancel button', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Cancel booking?" consequence="c" onConfirm={() => {}} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  // jsdom does not lay out CSS (see Toast's tests for the full reasoning) —
  // what's honestly testable here is that both actions render as real,
  // enabled, focusable buttons; ConfirmDialog.module.css's own use of
  // --control-h-touch on .cancel/.confirm is what actually provides the size.
  it('renders both actions as real, focusable buttons', () => {
    render(<ConfirmDialog title="t" consequence="c" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Cancel' }).tagName).toBe('BUTTON');
    expect(screen.getByRole('button', { name: 'Confirm' }).tagName).toBe('BUTTON');
  });
});
