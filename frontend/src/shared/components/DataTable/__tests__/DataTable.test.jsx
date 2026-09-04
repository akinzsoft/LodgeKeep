import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable } from '../DataTable.jsx';
import { StatusPill } from '../../StatusPill/StatusPill.jsx';
import { Money, formatMoney } from '../../../format/money.jsx';

const columns = [
  { key: 'guest', label: 'Guest' },
  { key: 'status', label: 'Status', render: (row) => <StatusPill tone={row.tone} label={row.statusLabel} /> },
  {
    key: 'balance',
    label: 'Balance',
    align: 'right',
    render: (row) => <Money amount={row.balance} currencyCode="NGN" />,
  },
];

const rows = [
  { id: 1, guest: 'Ada Bello', tone: 'success', statusLabel: 'Paid', balance: '0.00' },
  { id: 2, guest: 'Sam Okoro', tone: 'warning', statusLabel: 'Due', balance: '12500.00' },
];

describe('<DataTable>', () => {
  it('renders a loading state (TESTING.md FE-1)', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} state="loading" />);
    expect(screen.getByTestId('card-loading')).toBeInTheDocument();
  });

  it('renders an empty state when there are no rows, even without an explicit state prop', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyMessage="No arrivals today" />);
    expect(screen.getByText('No arrivals today')).toBeInTheDocument();
  });

  it('renders an error state (TESTING.md FE-1)', () => {
    render(
      <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} state="error" errorMessage="Could not load guests." />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load guests.');
  });

  it('renders rows with status as a pill carrying a text label (TESTING.md FE-4)', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Due')).toBeInTheDocument();
  });

  it('renders money with tabular numerals and the currency always shown (TESTING.md FE-3)', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const balance = screen.getByText(formatMoney('12500.00', 'NGN'));
    expect(balance).toHaveClass('tabular-nums');
  });

  it('renders row actions right-aligned, one set per row', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        actions={(row) => <button>View {row.guest}</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'View Ada Bello' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View Sam Okoro' })).toBeInTheDocument();
  });

  it('renders a toolbar slot above the table for filter/search controls', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        toolbar={<input placeholder="Search guests" />}
      />
    );
    expect(screen.getByPlaceholderText('Search guests')).toBeInTheDocument();
  });

  it('gives every data cell a data-label matching its column, for the mobile stacked-card CSS transform', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const cell = screen.getByText('Ada Bello');
    expect(cell).toHaveAttribute('data-label', 'Guest');
  });
});
