# DESIGN_SYSTEM.md

Companion to `AGENT.md`. Follow this for all frontend visual implementation — colours, spacing, typography, and the six required UI states. Domain correctness in `PRODUCT_REQUIREMENTS.md` and `ARCHITECTURE.md` takes priority when the two conflict; this file governs presentation, not behaviour.

## 1. Design system (apply everywhere)

Define these as CSS custom properties once, in a single `tokens.css`, and reference them everywhere. No hardcoded hex values in component files — a colour that appears literally in a component is a defect, because the next tenant theme override won't reach it.

**Colour tokens** — the "Navy & blue" palette: a dark navy sidebar, a bright-blue primary accent, solid-blue table headers, a cool near-white canvas, and four KPI tile colours (blue, green, yellow, navy). (It replaced the earlier "Lodgekeep warm" cream/brass/teal palette; reverting the redesign commit restores that.) Contrast was measured: the reference's own tile colours fail as text carriers (white on its blue is 3.1:1, on its green 2.0:1, on its yellow 1.45:1), so every fill that carries white text is deepened to at least 4.7:1, and the yellow tile carries dark text (11:1) instead. The reference's red tile is deliberately not used for a KPI: red means negative/destructive in the status vocabulary below, so that slot is navy.

```css
:root {
  /* surfaces */
  --surface-page:    #F3F6FC;   /* cool near-white canvas */
  --surface-card:    #FFFFFF;   /* cards, tables, modals */
  --surface-sunken:  #EEF2FA;   /* inset areas, hover rows */
  --border:          #E1E7F3;   /* hairline dividers */
  --border-strong:   #C9D2E6;   /* input borders, emphasis */

  /* text — AA on white */
  --text-primary:    #151B33;   /* headings, KPI numerals (17:1) */
  --text-secondary:  #465070;   /* labels, supporting copy (8:1) */
  --text-muted:      #5F6A8A;   /* hints, placeholders, timestamps (5.4:1) */
  --text-inverse:    #FFFFFF;   /* text on filled buttons/badges/tiles */

  /* accents */
  --accent:            #2563EB;  /* blue — buttons, active states, focus, links */
  --accent-hover:      #1D4FC4;
  --accent-tint:       #E8F0FE;
  --accent-secondary:  #1B7F45;  /* green — avatars, up-deltas, secondary emphasis (5.0:1) */
  --accent-tertiary:   #FFD22E;  /* yellow KPI tile — DARK text only */
  --accent-navy:       #14205B;  /* navy KPI tile / sidebar ground */

  /* solid-blue table header */
  --table-head-bg:   #2563EB;
  --table-head-text: #FFFFFF;

  /* dark navy sidebar */
  --sidebar-bg:          #14205B;
  --sidebar-text:        #DCE3FA;
  --sidebar-text-muted:  #A3B0DC;
  --sidebar-active-bg:   #2A3C8F;   /* a lighter navy pill */
  --sidebar-active-text: #FFFFFF;

  /* domain accents — assigned by meaning, reused on every screen */
  --domain-booking:  #2563EB;   /* reservations, bookings — shares --accent */
  --domain-rooms:    #8A6A00;   /* rooms, inventory, housekeeping — dark amber */
  --domain-guest:    #1B7F45;   /* profiles, guests, CRM — green */
  --domain-money:    #0F7C8F;   /* cashiering, revenue, AR — teal */

  /* semantic state — meaning, never decoration */
  --state-success:   #1F7A4D;
  --state-success-bg:#E3F4EA;
  --state-warning:   #8A5F0E;
  --state-warning-bg:#FFF3D1;
  --state-danger:    #C62F2F;   /* negative, down, destructive only */
  --state-danger-bg: #FDE8E8;
  --state-info:      #2563EB;
  --state-info-bg:   #E8F0FE;
  --state-neutral:   #4F5A78;
  --state-neutral-bg:#EDF0F7;

  /* charts — ordered series colours */
  --chart-1: #4A90FF;  --chart-2: #A9CFFF;  --chart-3: #FFC83D;  --chart-4: #6BCB77;
}
```

Shape: radii are 8 / 10 / 14px (inputs, buttons, cards), and cards lift with `--shadow-card` (a soft navy-tinted shadow) rather than relying on a border alone. Table header rows are solid blue with white text. The Home KPI row is solid colour tiles (blue, green, yellow, navy) with a white icon chip; the POS Register keeps its own fixed dark panel, retoned to deep navy (`--pos-register-*`).

Each domain accent needs a matching tint for icon-badge backgrounds (roughly the same hue at ~15% saturation) — define these alongside rather than computing opacity at render time, which produces muddy results over the sunken surface.

**Status colour vocabulary** — system-wide, never re-mapped per screen. This is operational vocabulary that staff learn once:

| State | Token | Applies to |
|---|---|---|
| Clean / available / confirmed / paid | `--state-success` | room status, reservation status, folio balance |
| Dirty / pending / arriving / due | `--state-warning` | room status, arrivals, outstanding balance |
| Out of order / overdue / cancelled / failed | `--state-danger` | room status, AR ageing, cancelled bookings |
| Occupied / in-house / in progress | `--state-info` | room status, active stays |
| Out of service / inactive / archived | `--state-neutral` | rooms, deactivated users |

Status is always rendered as a filled, fully rounded pill with a small leading dot — background `--state-*-bg`, text `--state-*`, never plain coloured text on white, which fails contrast at small sizes.

**Spacing & sizing**

```css
:root {
  --space-1: 4px;   --space-2: 8px;   --space-3: 12px;
  --space-4: 16px;  --space-5: 24px;  --space-6: 32px;  --space-8: 48px;

  --radius-sm:   6px;   /* inputs, small badges */
  --radius-md:   8px;   /* buttons, small cards */
  --radius-lg:   10px;  /* cards, modals */
  --radius-full: 999px; /* status pills, avatars, progress bars */

  --shadow-card:  0 1px 2px rgba(31,41,38,0.03);   /* cards read by their border, not a lift */
  --shadow-raised:0 12px 32px rgba(20,25,28,0.14);

  --sidebar-w:        248px;
  --sidebar-w-collapsed: 72px;
  --topbar-h:         64px;
  --control-h:        40px;  /* inputs, buttons — 44px on touch screens */
  --control-h-touch:  44px;
  --control-h-pos:    64px;  /* PLAN.md Phase 4: the POS order screen only — see "Touch targets" below */
}
```

All spacing is a multiple of 4px. Card padding is `--space-4` on mobile, `--space-5` on desktop.

**Typography**

```css
:root {
  --font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;  /* folio amounts, confirmation codes, IDs */

  --text-kpi:      28px/1.2  700;   /* dashboard KPI numerals */
  --text-h1:       24px/1.3  700;
  --text-h2:       19px/1.35 600;
  --text-h3:       16px/1.4  600;
  --text-body:     14px/1.6  400;
  --text-label:    13px/1.4  500;
  --text-caption:  12px/1.4  400;
}
```

Inter is self-hosted (`@fontsource/inter`, loaded once in `main.jsx`) so terminals that are offline still render it. `--font-display` now aliases Inter (the Home greeting and sidebar wordmark used to be a serif, Fraunces, before the Tripler palette; Fraunces is no longer loaded). Weights: 400 body, 500 labels, 600 headings, 700 page titles and KPI numerals. Never below 12px — front-desk terminals are often old, low-resolution, and viewed at arm's length. **Tabular figures (`font-variant-numeric: tabular-nums`) on every money column and folio total**, so digits align vertically down a column; proportional figures in a folio are genuinely hard to scan.

**Touch targets**: minimum 44×44px on any screen a housekeeper or front-desk agent uses on a tablet or phone (3.18). Desktop-only admin screens may use 40px. **The POS order screen (3.4) is the one place this bends further**: PRODUCT_REQUIREMENTS.md §3.4 names it explicitly as "a different design problem from the rest of the product — used standing up, at speed, often one-handed, on a touch terminal... aim for 64px+ here." `--control-h-pos` (64px) is that token — scoped to `app/pos/`'s own order-screen components only, never used elsewhere in the admin app, and paired with fewer words and higher information sparsity than every other screen in this spec uses.

**Focus & accessibility**: a visible focus ring (`2px solid --accent`, 2px offset) on every interactive element — text inputs, selects and textareas instead get an `--accent` border plus a 3px `--accent-ring` halo — front-desk staff are keyboard-heavy and speed matters more than polish. Body text must hit WCAG AA (4.5:1); status pills must hit AA at their small size, which is why they use tinted backgrounds rather than coloured text. Never encode meaning in colour alone — every status pill carries a text label, since a colour-blind night auditor still needs to read the room grid.

**Cards**: `--surface-card` background, 1px `--border` hairline, `--radius-lg`, `--shadow-card`, `--space-5` padding. Cards are the default container for everything — KPIs, charts, tables, forms.

**Icon badges**: filled rounded-square (`--radius-md`) in the domain tint, icon in the domain accent. Colour by domain, reused across every screen.

**Tables**: card container, sticky `--surface-sunken` header with small uppercase column labels, hairline row separators with a hover highlight (no zebra striping), status as pill, row actions right-aligned. Filter and search live at the top of the card.

**Responsive breakpoints**

```css
/* mobile-first */
@media (min-width: 640px)  { /* large phone / small tablet */ }
@media (min-width: 1024px) { /* tablet landscape — sidebar collapses to icons */ }
@media (min-width: 1280px) { /* desktop — full sidebar */ }
```

Sidebar: full → icon-only at 1024px → off-canvas drawer below 640px. KPI rows reflow 4 → 2 → 1. Tables become stacked cards on mobile rather than scrolling horizontally.

**Tenant theming**: each tenant can override `--domain-*` accents and supply a logo (3.19). The guest-facing portal (PRODUCT_REQUIREMENTS.md §3.14) is themed entirely from tenant config; the admin shell keeps the product's own identity so support staff see a consistent UI across customers. Because theming works through token overrides, this only holds if components never hardcode colour.

## 2. Feedback & state (specify these once, use everywhere)

Every screen needs all six states designed, not just the happy path. Missing states are the most common gap between a demo and a system staff trust.

- **Loading** — skeleton placeholders matching the shape of the content (grey blocks at the real dimensions), never a spinner over stale numbers. A KPI card showing yesterday's revenue while today's loads is worse than showing nothing.
- **Empty** — explain what belongs here and give the action that fills it ("No arrivals today" / "No rate plans yet — create one"). Never a blank card.
- **Success** — toast, top-right, `--state-success-bg` background with `--state-success` text and a check icon, auto-dismiss after ~4s. Wording is past tense and plain: "Check-in complete", "Folio posted", "Rate saved". Never "successfully" — the toast is the success. Destructive-adjacent successes (void, refund, cancellation) show a persistent inline confirmation instead of a disappearing toast, because the operator may need to reference what happened.
- **Error** — say what happened and what to do, in one sentence, without a raw exception string: "Payment declined. Try another method or take cash." Field-level errors sit inline beneath the field in `--state-danger`; operation-level errors sit in a banner at the top of the affected card. Errors never auto-dismiss.
- **Warning / confirmation** — anything irreversible or financial (void a line item, refund, cancel a booking, run night audit, change a tax rate, delete a rate plan) requires an explicit confirm step stating the consequence in plain words. Confirmations for money operations require a reason field, which feeds the audit trail (SECURITY.md §1.1).
- **Offline / degraded** — front-desk terminals lose connectivity mid-shift. Show a persistent banner when the connection drops, disable actions that would post financial transactions, and never silently queue a payment as though it succeeded.

Toasts are for transient confirmation only. Anything a manager may need to act on later — a failed email send, a housekeeping discrepancy, a fraud alert — goes to the notification bell (3.21) and the relevant screen, not a toast that vanishes in four seconds.

