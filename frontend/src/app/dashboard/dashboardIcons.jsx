/**
 * Line icons for the Home dashboard's KPI badges — hand-authored inline SVGs
 * using `currentColor`, the same approach `pos/registerCategoryIcons.jsx`
 * takes, since this codebase bundles no icon library.
 */
function IconBase({ children }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function BookingsIcon() {
  return (
    <IconBase>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </IconBase>
  );
}

export function RoomsIcon() {
  return (
    <IconBase>
      <path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7" />
      <path d="M3 15h18M3 18v2M21 18v2" />
      <path d="M7 9V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
    </IconBase>
  );
}

export function NewGuestsIcon() {
  return (
    <IconBase>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M19 8v6M16 11h6" />
    </IconBase>
  );
}

export function RevenueIcon() {
  return (
    <IconBase>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1.3" />
    </IconBase>
  );
}

export function OccupancyIcon() {
  return (
    <IconBase>
      <path d="M4 20V10l8-6 8 6v10" />
      <path d="M9 20v-6h6v6" />
    </IconBase>
  );
}

export function RateIcon() {
  return (
    <IconBase>
      <path d="M3.5 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7.5l8 8-9 9z" />
      <circle cx="8" cy="8" r="1.4" />
    </IconBase>
  );
}

export function RevparIcon() {
  return (
    <IconBase>
      <path d="M4 20h16" />
      <path d="M7 16v-4M12 16V8M17 16v-7" />
    </IconBase>
  );
}

export function ArrivalIcon() {
  return (
    <IconBase>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M3 12h11M10 8l4 4-4 4" />
    </IconBase>
  );
}

export function DepartureIcon() {
  return (
    <IconBase>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="M21 12H10M17 8l4 4-4 4" />
    </IconBase>
  );
}

export function InHouseIcon() {
  return (
    <IconBase>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 14.2a4.5 4.5 0 0 1 5 5.3" />
    </IconBase>
  );
}

