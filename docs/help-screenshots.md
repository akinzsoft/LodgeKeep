# Help guide media: how to re-capture the screenshots

Guides are markdown files in `frontend/src/app/help/content/`. A guide may start with front matter:

```
---
video: https://www.youtube.com/watch?v=abc123   # YouTube, Vimeo, Loom, Cloudflare Stream, or a direct https .mp4
video_title: Setting up rooms
images:
  - file: getting-started/02-rooms-and-rates/1-room-types.webp   # under frontend/public/help/images/
    alt: The Room Types tab with one type listed
    caption: Setup → Room Types
---
```

The video loads nothing from its host until the reader presses play. Do not commit video files: host them and link them. Every help image must be a `.webp` of 300 KB or less (a test fails otherwise).

## Re-running the capture

1. Use a throwaway local database (not the shared one if it is behind on migrations):
   `docker exec lodgekeep-mysql-1 mysql -uroot -p… -e "create database lodgekeep_dev_help; grant all on lodgekeep_dev_help.* to 'lodgekeep'@'%'"`
   then `cd backend && DB_NAME=lodgekeep_dev_help npx knex migrate:latest`.
2. Seed the fictional demo hotel ("Palm Grove Demo Hotel", slug `demo-help`):
   `cd backend && DB_NAME=lodgekeep_dev_help EMAIL_PROVIDER=console node scripts/seed-help-demo.js` (add `--reset` to rebuild).
   It refuses unless NODE_ENV is not production, DB_NAME is `lodgekeep_dev` or `lodgekeep_dev_<suffix>`, the DB host is local, no real app domain or email provider is configured and no live Paystack key is present.
3. Start the app against that database: `DB_NAME=lodgekeep_dev_help EMAIL_PROVIDER=console node src/server.js` in `backend/`, and `npx vite --port 5173` in `frontend/`.
4. `cd frontend && npx playwright install chromium` once (an installed Google Chrome is used if that is skipped), then `npm run help:capture` (add `--guide=getting-started/05-pos` for one guide).
5. The script writes `frontend/public/help/images/<guide>/<name>.webp` (fixed 1280x800 viewport, light theme, no browser chrome, the target highlighted in red) and prints the `images:` front matter to paste into the guide if it changed.

What to capture is listed in `frontend/scripts/help-capture/manifest.json`: per guide, each screenshot's `name`, `alt`, `caption`, the `steps` to click (by role and accessible name) and the element to `highlight`. The script only visits `*.localhost` addresses.

## Screen-by-screen screenshots

One shot per top-level screen and per sub-tab (84), all 1280x800 in the light theme, named `screens/<screen>/<tab>.webp` so any guide can list them in its `images:` front matter. They come from the `screens` entry in `manifest.json`; capture a subset with `npm run help:capture -- --guide=screens --match=booking/`. The demo hotel (`seed-help-demo.js`) books reservations in every state, runs three real Night Audits, and adds folios, a company account with an invoice and payment, a group block, an out-of-order room, a card-terminal POS sale with a cash-up, stock, expenses and a small supermarket, all through app calls. Sign-in pop-up cards are dismissed before capture. Manifest steps can also `fill`, `select` (by `option` or `contains`), `scroll` and `wait`; dates written as `@today-4` resolve against the demo property's date.

Known gaps: Discounts & comps, Door Access, Data Migration History and Support access show their empty state because the demo has no data for them. Payment reconciliation shows no Paystack payments (the demo has no payment provider).

| Screen | Tab or view | File (under `frontend/public/help/images/`) |
|---|---|---|
| Home | — | `screens/home/home.webp` |
| Booking | Availability | `screens/booking/availability.webp` |
| Booking | Tape Chart | `screens/booking/tape-chart.webp` |
| Booking | Reservations | `screens/booking/reservations.webp` |
| Booking | Waitlist | `screens/booking/waitlist.webp` |
| Booking | Front Desk | `screens/booking/front-desk.webp` |
| Profiles | Guests | `screens/profiles/guests.webp` |
| Profiles | Companies | `screens/profiles/companies.webp` |
| Rooms | Room Types | `screens/rooms/room-types.webp` |
| Rooms | Rooms | `screens/rooms/rooms.webp` |
| Housekeeping | Board | `screens/housekeeping/board.webp` |
| Housekeeping | Discrepancies | `screens/housekeeping/discrepancies.webp` |
| Housekeeping | Out of Order | `screens/housekeeping/out-of-order.webp` |
| Cashiering | Balances | `screens/cashiering/balances.webp` |
| Cashiering | Folio Lookup | `screens/cashiering/folio-lookup.webp` |
| Accounts Receivable | Accounts | `screens/ar/accounts.webp` |
| Accounts Receivable | Invoices | `screens/ar/invoices.webp` |
| Accounts Receivable | Ageing | `screens/ar/ageing.webp` |
| Accounts Receivable | Payments | `screens/ar/payments.webp` |
| Group Blocks | Blocks | `screens/group-blocks/blocks.webp` |
| Group Blocks | Room Allocations | `screens/group-blocks/room-allocations.webp` |
| Group Blocks | Rooming List | `screens/group-blocks/rooming-list.webp` |
| Group Blocks | Pickup & Billing | `screens/group-blocks/pickup-billing.webp` |
| Reporting | Business summary | `screens/reporting/business-summary.webp` |
| Reporting | Occupancy | `screens/reporting/occupancy.webp` |
| Reporting | Revenue | `screens/reporting/revenue.webp` |
| Reporting | Housekeeping | `screens/reporting/housekeeping.webp` |
| Reporting | Payment reconciliation | `screens/reporting/payment-reconciliation.webp` |
| Reporting | Discounts & comps | `screens/reporting/discounts-comps.webp` |
| POS | Register | `screens/pos/register.webp` |
| POS | Tickets | `screens/pos/tickets.webp` |
| POS | Guest orders | `screens/pos/guest-orders.webp` |
| POS | Shifts | `screens/pos/shifts.webp` |
| POS | Sales | `screens/pos/sales.webp` |
| POS | QR codes | `screens/pos/qr-codes.webp` |
| POS | Stock | `screens/pos/stock.webp` |
| POS | Setup | `screens/pos/setup.webp` |
| POS → Stock | Stock items | `screens/pos-stock/stock-items.webp` |
| POS → Stock | Recipes | `screens/pos-stock/recipes.webp` |
| POS → Stock | Goods received | `screens/pos-stock/goods-received.webp` |
| POS → Stock | Requests | `screens/pos-stock/requests.webp` |
| POS → Stock | Transfer | `screens/pos-stock/transfer.webp` |
| POS → Stock | Stock takes | `screens/pos-stock/stock-takes.webp` |
| POS → Stock | Wastage | `screens/pos-stock/wastage.webp` |
| POS → Stock | Reorder report | `screens/pos-stock/reorder-report.webp` |
| POS → Stock | Reports | `screens/pos-stock/reports.webp` |
| Supermarket | Sell | `screens/supermarket/sell.webp` |
| Supermarket | Today's sales | `screens/supermarket/todays-sales.webp` |
| Supermarket | Request stock | `screens/supermarket/request-stock.webp` |
| Supermarket | Wastage | `screens/supermarket/wastage.webp` |
| Supermarket | All sales | `screens/supermarket/all-sales.webp` |
| Supermarket | Setup | `screens/supermarket/setup.webp` |
| Supermarket | Products import | `screens/supermarket/products-import.webp` |
| Night Audit | — | `screens/night-audit/night-audit.webp` |
| Staff | — | `screens/staff/staff.webp` |
| Setup | Guided Setup | `screens/setup/guided-setup.webp` |
| Setup | Property | `screens/setup/property.webp` |
| Setup | Branding | `screens/setup/branding.webp` |
| Setup | Room Types | `screens/setup/room-types.webp` |
| Setup | Rooms | `screens/setup/rooms.webp` |
| Setup | Rate Codes & Calendar | `screens/setup/rate-codes-calendar.webp` |
| Setup | Taxes | `screens/setup/taxes.webp` |
| Setup | Reference Data | `screens/setup/reference-data.webp` |
| Setup | Users | `screens/setup/users.webp` |
| Setup | Email | `screens/setup/email.webp` |
| Setup | Payments | `screens/setup/payments.webp` |
| Setup | Security | `screens/setup/security.webp` |
| Setup | Notifications | `screens/setup/notifications.webp` |
| Setup | Support access | `screens/setup/support-access.webp` |
| Billing | — | `screens/billing/billing.webp` |
| Expenses | Categories | `screens/expenses/categories.webp` |
| Expenses | Record Expense | `screens/expenses/record-expense.webp` |
| Expenses | Recurring | `screens/expenses/recurring.webp` |
| Expenses | Reports | `screens/expenses/reports.webp` |
| Door Access | Alerts | `screens/door-access/alerts.webp` |
| Door Access | Import lock log | `screens/door-access/import-lock-log.webp` |
| Door Access | Stay confirmations | `screens/door-access/stay-confirmations.webp` |
| Door Access | Settings | `screens/door-access/settings.webp` |
| Data Migration | Templates | `screens/data-migration/templates.webp` |
| Data Migration | New Import | `screens/data-migration/new-import.webp` |
| Data Migration | History | `screens/data-migration/history.webp` |
| Multi-Property Roll-up | — | `screens/multi-property/roll-up.webp` |
| User menu | My Profile | `screens/my-profile/my-profile.webp` |
| Help | — | `screens/help/help.webp` |
