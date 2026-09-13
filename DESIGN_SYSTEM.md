# DESIGN_SYSTEM.md

Companion to `AGENT.md`. Follow this for all frontend visual implementation — colours, spacing, typography, and the six required UI states. Domain correctness in `PRODUCT_REQUIREMENTS.md` and `ARCHITECTURE.md` takes priority when the two conflict; this file governs presentation, not behaviour.

## 1. Design system (apply everywhere)

Define these as CSS custom properties once, in a single `tokens.css`, and reference them everywhere. No hardcoded hex values in component files — a colour that appears literally in a component is a defect, because the next tenant theme override won't reach it.

**Colour tokens** — the "Lodgekeep warm" palette: a warm cream canvas, white cards with a warm hairline border, a dark charcoal sidebar, brass as the primary accent, deep teal as the secondary, and brick reserved for negative/down signals.

```css
:root {
  /* surfaces */
  --surface-page:    #FAF8F4;   /* warm cream canvas — never pure white */
  --surface-card:    #FFFFFF;   /* cards, tables, modals */
  --surface-sunken:  #F4F0E8;   /* inset areas, table headers, hover rows */
  --border:          #EAE4D6;   /* warm hairline dividers */
  --border-strong:   #D9D0BF;   /* input borders, emphasis */

  /* text — AA on white */
  --text-primary:    #1F2926;   /* headings, KPI numerals */
  --text-secondary:  #5C6B66;   /* labels, supporting copy */
  --text-muted:      #6E7873;   /* hints, placeholders, timestamps (4.57:1) */
  --text-inverse:    #FFFFFF;   /* text on filled buttons/badges */

  /* accents */
  --accent:           #8A6D3B;  /* brass — buttons, active states, focus, links */
  --accent-hover:     #735A2F;
  --accent-tint:      #F3EDE2;
  --accent-secondary: #2E5850;  /* deep teal — avatars, up-deltas, secondary emphasis */

  /* dark sidebar */
  --sidebar-bg:          #14191C;
  --sidebar-text:        #D9DDD9;
  --sidebar-text-muted:  #8B9490;
  --sidebar-active-bg:   #3A3222;   /* brass, deepened for the charcoal ground */
  --sidebar-active-text: #F4EEE1;

  /* domain accents — assigned by meaning, reused on every screen */
  --domain-booking:  #8A6D3B;   /* reservations, bookings — shares --accent */
  --domain-rooms:    #9A6A26;   /* rooms, inventory, housekeeping — ochre */
  --domain-guest:    #2E5850;   /* profiles, guests, CRM — teal */
  --domain-money:    #4A7058;   /* cashiering, revenue, AR — sage */

  /* semantic state — meaning, never decoration */
  --state-success:   #2E6B4F;
  --state-success-bg:#E5EFE9;
  --state-warning:   #93641C;
  --state-warning-bg:#F6EDDA;
  --state-danger:    #B5482F;   /* brick — negative, down, destructive only */
  --state-danger-bg: #F6E4DE;
  --state-info:      #2E5850;
  --state-info-bg:   #E3ECE9;
  --state-neutral:   #5C6B66;
  --state-neutral-bg:#EFEBE3;

  /* charts — ordered series colours */
  --chart-1: #8A6D3B;  --chart-2: #2E5850;  --chart-3: #B5482F;  --chart-4: #CDB791;
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

Inter is self-hosted (`@fontsource/inter`, loaded once in `main.jsx`) so terminals that are offline still render it. `--font-display` (Fraunces, `@fontsource/fraunces`) is reserved for the Home greeting and the sidebar wordmark — never body text, labels, or numerals. Weights: 400 body, 500 labels, 600 headings, 700 page titles and KPI numerals. Never below 12px — front-desk terminals are often old, low-resolution, and viewed at arm's length. **Tabular figures (`font-variant-numeric: tabular-nums`) on every money column and folio total**, so digits align vertically down a column; proportional figures in a folio are genuinely hard to scan.

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

