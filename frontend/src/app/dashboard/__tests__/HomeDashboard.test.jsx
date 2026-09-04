import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HomeDashboard } from '../HomeDashboard.jsx';

describe('<HomeDashboard>', () => {
  it('greets the signed-in user by name', () => {
    render(<HomeDashboard greetingName="Emily Smith" />);
    expect(screen.getByRole('heading', { name: 'Hi, Emily Smith!' })).toBeInTheDocument();
  });

  it('falls back to a generic greeting with no name', () => {
    render(<HomeDashboard />);
    expect(screen.getByRole('heading', { name: 'Welcome back!' })).toBeInTheDocument();
  });

  it('renders all four KPI cards from the spec, each naming the module its number will come from', () => {
    render(<HomeDashboard greetingName="Emily" />);
    expect(screen.getByText('Total Booking')).toBeInTheDocument();
    expect(screen.getByText(/Available once Reservations is set up/)).toBeInTheDocument();
    expect(screen.getByText('Rooms Available')).toBeInTheDocument();
    expect(screen.getByText(/Available once Rooms Management is set up/)).toBeInTheDocument();
    expect(screen.getByText('New Customers')).toBeInTheDocument();
    expect(screen.getByText(/Available once Guest Profiles is set up/)).toBeInTheDocument();
    expect(screen.getByText('Total Revenue')).toBeInTheDocument();
    expect(screen.getByText(/Available once Cashiering is set up/)).toBeInTheDocument();
  });

  it('never renders a fabricated KPI number — every value is the honest placeholder', () => {
    render(<HomeDashboard greetingName="Emily" />);
    // Four KPI cards, each showing "—" rather than any number.
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('renders the chart row as named, honest empty states', () => {
    render(<HomeDashboard greetingName="Emily" />);
    expect(screen.getByText('New vs Returning Customers')).toBeInTheDocument();
    expect(screen.getByText('Bookings by Room Type')).toBeInTheDocument();
  });

  it('renders the operational alert strip with all five spec items, each an honest status pill', () => {
    render(<HomeDashboard greetingName="Emily" />);
    ['Arrivals today', 'Departures today', 'Housekeeping discrepancies', 'Oversold room types tonight', "Night audit for today's business date"].forEach(
      (label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    );
    expect(screen.getAllByText('Not available yet')).toHaveLength(5);
  });
});
