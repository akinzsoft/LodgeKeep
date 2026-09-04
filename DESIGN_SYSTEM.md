# DESIGN_SYSTEM.md

Companion to `AGENT.md`. Follow this for all frontend visual implementation — colours, spacing, typography, and the six required UI states. Domain correctness in `PRODUCT_REQUIREMENTS.md` and `ARCHITECTURE.md` takes priority when the two conflict; this file governs presentation, not behaviour.

## 1. Design system (apply everywhere)

Define these as CSS custom properties once, in a single `tokens.css`, and reference them everywhere. No hardcoded hex values in component files — a colour that appears literally in a component is a defect, because the next tenant theme override won't reach it.

**Colour tokens**

```css
:root {
  /* surfaces */
  --surface-page:    #F4F6FB;   /* app background — never pure white */
  --surface-card:    #FFFFFF;   /* cards, tables, modals */
  --surface-sunken:  #EDF0F7;   /* inset areas, table zebra rows */
  --border:          #E3E8F0;   /* hairline dividers */
  --border-strong:   #CBD3E1;   /* input borders, emphasis */

  /* text */
  --text-primary:    #1C2434;   /* headings, KPI numerals */
  --text-secondary:  #5A6478;   /* labels, supporting copy */
  --text-muted:      #8A93A6;   /* hints, placeholders, timestamps */
  --text-inverse:    #FFFFFF;   /* text on filled buttons/badges */

  /* domain accents — assigned by meaning, reused on every screen */
  --domain-booking:  #7F77DD;   /* reservations, bookings */
  --domain-rooms:    #EF9F27;   /* rooms, inventory, housekeeping */
  --domain-guest:    #639922;   /* profiles, guests, CRM */
  --domain-money:    #1D9E75;   /* cashiering, revenue, AR */

  /* semantic state — meaning, never decoration */
  --state-success:   #1D9E75;
  --state-success-bg:#E1F5EE;
  --state-warning:   #BA7517;
  --state-warning-bg:#FAEEDA;
  --state-danger:    #D14343;
  --state-danger-bg: #FCEBEB;
  --state-info:      #378ADD;
  --state-info-bg:   #E6F1FB;
  --state-neutral:   #8A93A6;
  --state-neutral-bg:#F1EFE8;
}
```

Each domain accent needs a matching tint for icon-badge backgrounds (roughly the same hue at ~15% saturation) — define these alongside rather than computing opacity at render time, which produces muddy results over the sunken surface.

**Status colour vocabulary** — system-wide, never re-mapped per screen. This is operational vocabulary that staff learn once:

| State | Token | Applies to |
|---|---|---|
| Clean / available / confirmed / paid | `--state-success` | room status, reservation status, folio balance |
| Dirty / pending / arriving / due | `--state-warning` | room status, arrivals, outstanding balance |
| Out of order / overdue / cancelled / failed | `--state-danger` | room status, AR ageing, cancelled bookings |
| Occupied / in-house / in progress | `--state-info` | room status, active stays |
| Out of service / inactive / archived | `--state-neutral` | rooms, deactivated users |

Status is always rendered as a filled pill — background `--state-*-bg`, text `--state-*`, never plain coloured text on white, which fails contrast at small sizes.

**Spacing & sizing**

```css
:root {
  --space-1: 4px;   --space-2: 8px;   --space-3: 12px;
  --space-4: 16px;  --space-5: 24px;  --space-6: 32px;  --space-8: 48px;

  --radius-sm:  6px;   /* pills, badges, inputs */
  --radius-md:  10px;  /* buttons, small cards */
  --radius-lg:  14px;  /* cards, modals */

  --shadow-card:  0 1px 3px rgba(28,36,52,0.06), 0 1px 2px rgba(28,36,52,0.04);
  --shadow-raised:0 4px 12px rgba(28,36,52,0.08);

  --sidebar-w:        248px;
  --sidebar-w-collapsed: 72px;
  --topbar-h:         64px;
  --control-h:        40px;  /* inputs, buttons — 44px on touch screens */
}
```

All spacing is a multiple of 4px. Card padding is `--space-4` on mobile, `--space-5` on desktop.

**Typography**

```css
:root {
  --font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;  /* folio amounts, confirmation codes, IDs */

  --text-kpi:      30px/1.2  600;   /* dashboard KPI numerals */
  --text-h1:       24px/1.3  600;
  --text-h2:       19px/1.35 600;
  --text-h3:       16px/1.4  600;
  --text-body:     14px/1.6  400;
  --text-label:    13px/1.4  500;
  --text-caption:  12px/1.4  400;
}
```

Weights: 400 body, 500 labels, 600 headings and numerals. Never below 12px — front-desk terminals are often old, low-resolution, and viewed at arm's length. **Tabular figures (`font-variant-numeric: tabular-nums`) on every money column and folio total**, so digits align vertically down a column; proportional figures in a folio are genuinely hard to scan.

**Touch targets**: minimum 44×44px on any screen a housekeeper or front-desk agent uses on a tablet or phone (3.18). Desktop-only admin screens may use 40px.

**Focus & accessibility**: a visible focus ring (`2px solid --domain-booking`, 2px offset) on every interactive element — front-desk staff are keyboard-heavy and speed matters more than polish. Body text must hit WCAG AA (4.5:1); status pills must hit AA at their small size, which is why they use tinted backgrounds rather than coloured text. Never encode meaning in colour alone — every status pill carries a text label, since a colour-blind night auditor still needs to read the room grid.

**Cards**: `--surface-card` background, `--radius-lg`, `--shadow-card`, `--space-5` padding. Cards are the default container for everything — KPIs, charts, tables, forms.

**Icon badges**: filled rounded-square (`--radius-md`) in the domain tint, icon in the domain accent. Colour by domain, reused across every screen.

**Tables**: card container, sticky header, `--surface-sunken` zebra rows or hairline separators, status as pill, row actions right-aligned. Filter and search live at the top of the card.

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

