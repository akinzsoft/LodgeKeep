# DESIGN_SYSTEM.md

Companion to `AGENT.md`. Follow this for all frontend visual implementation — colours, spacing, typography, and the six required UI states. Domain correctness in `PRODUCT_REQUIREMENTS.md` and `ARCHITECTURE.md` takes priority when the two conflict; this file governs presentation, not behaviour.

## 1. Design system (apply everywhere)

Define these as CSS custom properties once, in a single `tokens.css`, and reference them everywhere. No hardcoded hex values in component files — a colour that appears literally in a component is a defect, because the next tenant theme override won't reach it.

**Colour tokens** — the "Tripler" palette: a cool light-grey canvas, white cards with a soft indigo-tinted shadow, a light sidebar, indigo as the primary accent, sage and coral as supporting colours, and a deeper red reserved for negative/down signals. (It replaced the earlier "Lodgekeep warm" cream/brass/teal palette; reverting the redesign commit restores that.) Contrast was measured: the reference's pale sage `#8FB8A4` and coral `#FF6B57` are only 2.2:1 and 2.8:1 under white text, so every fill that carries text uses a deepened version at about 4.7:1 or better; the pale versions appear only as chart fills, never as the sole carrier of meaning.

```css
:root {
  /* surfaces */
  --surface-page:    #F5F6FA;   /* cool light canvas */
  --surface-card:    #FFFFFF;   /* cards, tables, modals */
  --surface-sunken:  #F0F1F7;   /* inset areas, table headers, hover rows */
  --border:          #E6E8F0;   /* hairline dividers */
  --border-strong:   #D3D6E3;   /* input borders, emphasis */

  /* text — AA on white */
  --text-primary:    #1F2033;   /* headings, KPI numerals (16:1) */
  --text-secondary:  #4F5270;   /* labels, supporting copy (7.6:1) */
  --text-muted:      #63677F;   /* hints, placeholders, timestamps (5.6:1) */
  --text-inverse:    #FFFFFF;   /* text on filled buttons/badges/tiles */

  /* accents */
  --accent:            #4B4A8C;  /* indigo — buttons, active states, focus, links */
  --accent-hover:      #3D3C75;
  --accent-tint:       #ECECF6;
  --accent-secondary:  #3F7A64;  /* deep sage — avatars, up-deltas, secondary emphasis */
  --accent-sage-fill:  #457F68;  /* sage KPI tile (white text 4.7:1) */
  --accent-tertiary:   #CF432B;  /* coral KPI tile (white text 4.7:1) */

  /* light sidebar */
  --sidebar-bg:          #EEF0F6;
  --sidebar-text:        #3A3C58;
  --sidebar-text-muted:  #63677F;
  --sidebar-active-bg:   #E1E1F3;   /* indigo tint */
  --sidebar-active-text: #4B4A8C;

  /* domain accents — assigned by meaning, reused on every screen */
  --domain-booking:  #4B4A8C;   /* reservations, bookings — shares --accent */
  --domain-rooms:    #8A6D1F;   /* rooms, inventory, housekeeping — dark sand */
  --domain-guest:    #3F7A64;   /* profiles, guests, CRM — sage */
  --domain-money:    #2F7A78;   /* cashiering, revenue, AR — teal */

  /* semantic state — meaning, never decoration */
  --state-success:   #2A6B52;
  --state-success-bg:#E6F1EC;
  --state-warning:   #8A5F0E;
  --state-warning-bg:#F8EDD2;
  --state-danger:    #BA3526;   /* negative, down, destructive only — deeper than the decorative coral */
  --state-danger-bg: #FBE7E3;
  --state-info:      #4B4A8C;
  --state-info-bg:   #ECECF6;
  --state-neutral:   #55586F;
  --state-neutral-bg:#EDEEF3;

  /* charts — ordered series colours */
  --chart-1: #4B4A8C;  --chart-2: #6BA38A;  --chart-3: #F2604B;  --chart-4: #DCC98A;
}
```

Shape: radii are 8 / 10 / 16px (inputs, buttons, cards), and cards lift with `--shadow-card` (a soft indigo-tinted shadow) rather than relying on a border alone. The Home KPI row is solid colour tiles (indigo, sage, coral) with a white icon chip; the POS Register keeps its own fixed dark panel, retoned to deep indigo (`--pos-register-*`).

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

