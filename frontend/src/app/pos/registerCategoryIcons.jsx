/**
 * registerCategoryIcons — small, hand-authored inline SVGs for the
 * Register redesign's category rail. This codebase bundles no icon
 * library (confirmed by reading `IconBadge.jsx`'s own header: "picking one
 * is a real product decision this file shouldn't make silently," and no
 * such library is a dependency anywhere) — these are plain 24×24 stroke
 * icons using `currentColor`, so they inherit the rail button's own text
 * color (brass when active, muted otherwise) with no extra styling.
 *
 * `pos_menu_items.category` is a free-text column (Setup's own tab has
 * always let a property type anything) — `iconForCategory` matches the
 * six names this design names by a case-insensitive substring match
 * (covers "Hot Drinks"/"Coffee & Tea" style real-world variants, not just
 * an exact "Coffee"), falling back to a plain generic tag icon for any
 * category a property has actually named something else entirely.
 */
function IconBase({ children, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function StartersIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="8" />
      <path d="M8 12a4 4 0 0 1 8 0" />
    </IconBase>
  );
}

function MainsIcon() {
  return (
    <IconBase>
      <path d="M6 3v7a3 3 0 0 0 3 3v8" />
      <path d="M6 3v5M9 3v5" />
      <path d="M17 3c-1.7 0-3 2-3 5s1.3 5 3 5v8" />
    </IconBase>
  );
}

function PizzaIcon() {
  return (
    <IconBase>
      <path d="M4 5l8 16 8-16a20 20 0 0 0-16 0z" />
      <circle cx="12" cy="10" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="13.5" r="0.9" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

function DrinksIcon() {
  return (
    <IconBase>
      <path d="M6 4h12l-2 15a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2L6 4z" />
      <path d="M7 9h10" />
    </IconBase>
  );
}

function CoffeeIcon() {
  return (
    <IconBase>
      <path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9z" />
      <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 5c0 1-1 1-1 2M12 5c0 1-1 1-1 2" />
    </IconBase>
  );
}

function DessertsIcon() {
  return (
    <IconBase>
      <path d="M12 3v3" />
      <path d="M4 11a8 8 0 0 1 16 0z" />
      <path d="M3 11h18l-1.5 8a2 2 0 0 1-2 1.7H6.5A2 2 0 0 1 4.5 19z" />
    </IconBase>
  );
}

function GenericIcon() {
  return (
    <IconBase>
      <path d="M4 4h7l9 9-7 7-9-9V4z" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

const KNOWN_CATEGORIES = [
  { match: 'starter', Icon: StartersIcon },
  { match: 'main', Icon: MainsIcon },
  { match: 'pizza', Icon: PizzaIcon },
  { match: 'drink', Icon: DrinksIcon },
  { match: 'coffee', Icon: CoffeeIcon },
  { match: 'dessert', Icon: DessertsIcon },
];

export function CategoryIcon({ category }) {
  const lower = (category ?? '').toLowerCase();
  const found = KNOWN_CATEGORIES.find(({ match }) => lower.includes(match));
  const Icon = found?.Icon ?? GenericIcon;
  return <Icon />;
}

/** The rail's own "All" entry has no real category to match — a plain grid glyph, distinct from the generic-category fallback above. */
export function AllCategoriesIcon() {
  return (
    <IconBase>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </IconBase>
  );
}

function CashIcon() {
  return (
    <IconBase size={16}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  );
}

function CardIcon() {
  return (
    <IconBase size={16}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </IconBase>
  );
}

function NqrIcon() {
  return (
    <IconBase size={16}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3M20 14v3h-3M14 20h3v-3M20 20h-3" />
    </IconBase>
  );
}

const PAYMENT_METHOD_ICONS = { Cash: CashIcon, Card: CardIcon, NQR: NqrIcon };

/** The 3-button payment-tender row's own small icons, one per real tender label (`RegisterTab.jsx`'s `PAYMENT_METHODS`). */
export function PaymentMethodIcon({ method }) {
  const Icon = PAYMENT_METHOD_ICONS[method];
  return Icon ? <Icon /> : null;
}

/** The ticket line's own "void this whole line" action — a plain line icon, matching every other icon in this file, rather than an emoji glyph (this app draws no emoji anywhere else). */
export function TrashIcon() {
  return (
    <IconBase size={15}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </IconBase>
  );
}
