import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PrintedFolio } from '../PrintedFolio.jsx';

const FOLIO = { folio_number: 'F1', billed_to: 'Guest', currency: 'NGN' };

describe('PrintedFolio balance', () => {
  it('prints a credit as Credit, not a negative number', () => {
    render(<PrintedFolio folio={{ ...FOLIO, balance: '-20240.00' }} lineItems={[]} property={{ name: 'Motel' }} />);
    expect(screen.getByText(/^Credit/)).toHaveTextContent(/20,240\.00/);
    expect(screen.queryByText(/-.*20,240\.00/)).not.toBeInTheDocument();
  });

  it('prints an owed balance as Outstanding', () => {
    render(<PrintedFolio folio={{ ...FOLIO, balance: '150.00' }} lineItems={[]} property={{ name: 'Motel' }} />);
    expect(screen.getByText(/^Outstanding/)).toHaveTextContent(/150\.00/);
  });
});
