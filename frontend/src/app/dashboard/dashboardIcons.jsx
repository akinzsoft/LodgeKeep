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
