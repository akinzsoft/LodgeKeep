/**
 * The few hand-authored icons the landing page uses — the app bundles no icon
 * library (`app/shell/navIcons.jsx` is the precedent). 24px, stroke only,
 * colour from `currentColor` so a token drives it.
 */
const base = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false };

export function CheckIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  );
}

export function PaystackIcon(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  );
}

export function TerminalIcon(props) {
  return (
    <svg {...base} {...props}>
      <rect x="6" y="3" width="12" height="18" rx="2.5" />
      <path d="M9 7h6M9 11h.01M12 11h.01M15 11h.01M9 14.5h.01M12 14.5h.01M15 14.5h.01" />
    </svg>
  );
}

export function QrIcon(props) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2M20 14v.01M14 20h.01M17 18v2h3" />
    </svg>
  );
}

export function CashIcon(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6.5 9.5v.01M17.5 14.5v.01" />
    </svg>
  );
}

export function PlayIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.8l5 3.2-5 3.2z" />
    </svg>
  );
}

export function QuoteIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M9 7H6.5A2.5 2.5 0 004 9.5V13h4.5V9.5M9 7v6a3 3 0 01-3 3M20 7h-2.5A2.5 2.5 0 0015 9.5V13h4.5V9.5M20 7v6a3 3 0 01-3 3" />
    </svg>
  );
}

export function CloseIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
