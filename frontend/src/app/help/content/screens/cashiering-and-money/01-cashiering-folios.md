---
images:
  - file: screens/cashiering/balances.webp
    alt: The Cashiering Balances tab listing in-house guests who owe money, with their rooms
    caption: Cashiering → Balances. Who owes what, and in which room
  - file: screens/cashiering/folio-lookup.webp
    alt: The Folio Lookup tab with a guest search and a reservation ID box
    caption: Cashiering → Folio Lookup. Find a guest, then work on their folio
---
# Cashiering: charges, payments, voids, split folios and refunds
## What it is for
A **folio** is a guest's bill for their stay. Cashiering is where you see who owes money, add charges, take payments, correct mistakes and give money back. Every line stays on the folio. A mistake is voided or adjusted, never deleted, so there is always a record.
## Who can do this
- Opening Cashiering, seeing balances and posting a **charge** needs `cashiering.post_charge`. By default that is front desk, cashier, manager, admin and super admin.
- Taking a **payment** or **deposit**, an **adjustment**, a **void**, a **Move**, a **split folio**, **Verify** and a **refund** all need `cashiering.void_line`. By default that is cashier, manager, admin and super admin. Front desk does not have it.
- **Bill to company** needs `ar.manage` (by default manager, admin and super admin).
- **Clear stuck refund** needs `cashiering.refund_clear` (by default manager, admin and super admin).
- Your hotel can change what each role holds.
## Where to click
Cashiering opens on **Balances**. Use **Folio Lookup** to work on a folio.
## Fields that matter
1. **Balances.** This lists guests currently staying whose balance is not zero, largest first: confirmation number, guest, room, dates and balance. Press **Refresh** for the latest, or **Export CSV** to save it. Press **View folio** to open that guest's folio.
2. **Folio Lookup.** Type a guest name, phone number or room and press **Search**, then open the match. You can also type a **Reservation ID** and press **Load folios**. A folio only exists once the guest has checked in, or if it was opened when the booking was made.
3. **Read the folio.** The top shows Open or Closed, the balance and a pill: **Paid in full** when the balance is zero, or **Credit balance** when the hotel owes the guest. **Print folio** prints it.
4. **Post a charge.** Press **Post a charge**, choose Room charge or POS charge, type a description and the amount, and press **Post charge**. Tax is added for you.
5. **Post an adjustment.** Press **Post an adjustment**. Type a description, an amount and a **reason**. A negative amount, such as -20.00, takes money off the bill, for example a discount.
6. **Void a line.** Press **Void** on the line, give a reason and confirm. The line stays on the folio, struck through, and it cannot be undone. Voiding a charge also voids its tax lines. A payment line cannot be voided. Refund the payment instead. A line that is already on an invoice cannot be voided. Correct it with an adjustment.
## Taking a payment or a deposit
1. Press **Capture a payment**. On a folio that is already paid in full the button says **Take a deposit**.
2. Choose the **Method**: Cash, Card (terminal), or Paystack (card/digital).
3. The **Amount** starts as the balance. You can change it. It must be more than zero, with at most two decimals. If you enter more than is owed, the screen says how much "will be kept as a credit (deposit)". That credit is used against later charges.
4. **Cash** is recorded at once. **Card (terminal)** is for a payment taken on your own card machine. You can pick the terminal account and type the machine's reference (both optional). LodgeKeep only records it.
5. **Paystack** needs the guest's email. Press **Pay now** to take it on this page, or give the guest the **Open payment page in a new tab** link. If the payment still shows pending afterwards, press **Verify** on its row to ask Paystack.
6. If the folio is billed to a company, there is no payment button. The screen says it is settled through Accounts Receivable.
## Split folios
- Press **Open a split folio** to start a second bill for the same stay, for example so a company pays the room and the guest pays extras.
- On a line, press **Move** and choose the other folio. A line can only move to another folio of the same stay, and the folio must be open.
## Refunds and credit
1. In the Payments table, press **Refund** on a captured payment.
2. Leave **Amount to refund** empty to refund everything still refundable, or type a smaller amount to refund part, for example the credit left after a deposit.
3. Give a reason and press **Confirm refund**. It cannot be undone, and you cannot refund more than was paid.
4. A Paystack refund can show **Refund waiting on Paystack**. LodgeKeep keeps checking. A manager with the right permission may later see **Clear stuck refund**. See [Voids and card refunds from Sales](help:screens/restaurant-and-bar/03-voids-and-card-refunds) for how that works.
5. Refunds here do not ask for a manager's PIN. Refunds of Register card sales do, and are done from POS → Sales.
## You are done when
The folio's balance is what you expect and the pill reads **Paid in full** (or the guest still owes only what you meant). Every payment shows as captured. Checkout is blocked while a balance is owing, so this is what lets the guest check out.
## What can go wrong
- A charge has the wrong tax, or none: see [A tax is missing or wrong](help:common-problems/tax-missing-or-wrong).
- Paystack will not open: see [Online payments do not start](help:common-problems/online-payments-do-not-start).
- Checkout is refused with a balance owing: see the first test day, [A first test booking, check-in, charge, payment and check-out](help:getting-started/07-first-test-day).
- The buttons are missing: your role may not hold the permission for them (see Who can do this above).
