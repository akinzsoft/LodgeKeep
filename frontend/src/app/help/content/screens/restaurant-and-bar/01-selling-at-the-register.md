---
images:
  - file: screens/pos/register.webp
    alt: The POS Register with the menu on the left and the order ticket on the right
    caption: POS → Register. Menu on the left, the open tab's ticket on the right
  - file: screens/pos/tickets.webp
    alt: The Tickets tab listing open tickets with how long each has waited
    caption: POS → Tickets. What the kitchen or bar still has to make
  - file: screens/pos/guest-orders.webp
    alt: The Guest orders tab listing orders placed from QR codes
    caption: POS → Guest orders. Orders guests placed from their phones
---
# Selling at the Register
## What it is for
The Register is where a bar, restaurant or other outlet rings up a sale. You open a **tab** (one customer's or table's running bill), add items to it, and then take payment. The Tickets and Guest orders tabs show the work still to be done.
## Who can do this
- Using the Register, Tickets, Guest orders and Shifts needs the permission `pos.operate`. By default that is the POS operator, manager, admin and super admin roles.
- Giving a discount or comp needs `discount.apply`. By default that is the same four roles.
- A manager (permission `pos.manage`) can also work on a tab that belongs to someone else.
- Your hotel can change what each role holds, so you may see less or more than this.
## Where to click
POS → **Register**. Choose the **Outlet** and the **Terminal** (the till you are working on) at the top.
## Fields that matter
1. **Open a tab.** Press **+ New tab** and give it a name, for example "Table 4". Pick a terminal first, or the Register will tell you to.
2. **Add items.** Tap an item tile once for each one you want. Use the category list or the search box to find it. An item marked **Sold out** cannot be added. If the menu looks out of date, press **Refresh menu**.
3. **Change the ticket.** On each line use the plus and minus buttons, the discount button or the bin to void it. If a line was added more than a couple of minutes ago, or the ticket is already marked done, you must give a reason: Customer changed mind, Wrong item, Item unavailable, or Other (say what happened).
4. **Remove a whole tab** with the cross on its tab. An empty tab goes at once. A tab with items asks for a reason, and it cannot be undone.
5. **Split the bill.** With two or more items, press **Split bill**. Give each item to Group 1, 2 or 3 (or leave it with no group). Each group is its own check and you choose how each one pays. Every group must be paid in the same step, using **Confirm settlement**.
6. **Take payment.** Choose how the customer pays, then press **Send to Bar & Checkout**. You will see the subtotal, the service charge, any tax and the total before you pay. The ways to pay are explained below.
7. **Receipt.** After a sale the receipt appears on the screen. Press **Print receipt** to print it.
## Discounts and comps
Press **Discount or comp** on a tab that has items. Choose **Discount** or **Comp**, whether it is for the whole check or one item, a percent or an amount, and a reason from the list. A **comp** gives the whole amount away.
- If a discount is within your limit it applies straight away. By default the limits are 5% for a POS operator, 25% for a manager, 50% for an admin and 100% for a super admin. Your hotel can set its own limits.
- If it is above your limit, or it is a comp, it shows **Waiting for a manager**. A manager presses **Approve**, picks their own name, and types their 6-digit approval PIN and a reason.
- The manager is shown the exact amount they are approving. Items added to the tab afterwards are not covered, so ask again for those.
- A discount that is still on the tab can be removed before the sale.
## Taking payment
- **Cash**: settles at once.
- **Card (external terminal)**: the customer pays on your own card machine. LodgeKeep only records it, and settles as soon as you press checkout. You may pick which terminal account it went into and type the machine's reference. Both are optional.
- **Card**: a Paystack payment window opens on the screen, with the ways your Paystack account allows. You can type the customer's email so the receipt goes to them. The screen shows "Opening", "Waiting for" and "Confirming" payment. If the payment fails or is not completed, nothing is settled and you can press checkout again.
- **NQR**: a Paystack window that shows a QR code. The customer scans it with their banking app. If your Paystack account has not switched this on, the Register says so, and you can choose another way to pay.
- **Charge to room instead**: type a room number or guest name and pick the guest from the list. Only guests currently staying are listed. Choose how the guest agreed (Signature, Room key presented or PIN) and type a reference. Both are required. The charge goes on the guest's room bill, with tax added. It is refused if the guest has checked out or the bill is closed.
- Nothing can be settled while you are offline.
## Whose tab is it?
1. The person who opens a tab owns it. Only the owner can add items, split, rename or check out.
2. On someone else's tab you will see "Another operator's tab — ask them to hand it over to you, or a manager can work on it".
3. To pass a tab on (for example at the end of a shift), the owner presses **Hand over** and chooses who it goes to under **Hand to**. **Hand over my tabs** passes all of yours at once.
4. A manager can work on another person's tab by typing why ("Work on this tab"). The reason is kept with everything they do on it. A manager who hands over someone else's tab must also give a reason.
5. Tabs from guest QR orders have no owner, so any operator at that outlet can work on them.
## A card was paid but the tab is not settled
Sometimes the customer pays by card but the sale does not finish, for example the browser closed. The Register then shows a red message at the top: "Customer paid by card but the tab is not settled: open the tab and press checkout, or refund." Each stranded payment is listed with its tab and amount and an **Open tab** button. Anyone who can use the Register (`pos.operate`) sees it, for the outlet they work at.
1. Press **Open tab**. The ticket says "Payment already received for this tab — checkout will use it instead of charging again."
2. Leave the items alone. While the payment is waiting you cannot add or remove items, or remove the tab. The Register says "A card payment for this check has already been taken. Settle it, or refund it, before adding or removing items."
3. Check that the total on the ticket is the same as the amount the customer paid. The payment can only be used for exactly the tab's current total.
4. If it matches, press **Send to Bar & Checkout**. The sale settles with the payment already taken, and the customer is not charged again.
5. If the total has changed since the customer paid (for example the tax or the service charge was switched on or off, or a discount was added), checkout fails with an amount mismatch: "The service charge or the check changed after this payment was started, so the amount paid no longer matches the total. Restart the payment (refund the captured one if money was taken)." **Do not keep retrying.** The payment will never match. Have a manager refund it, then take the payment again.
6. The refund is done by a manager in POS → **Sales**, under **Card payments to refund**. See [Voids and card refunds](help:screens/restaurant-and-bar/03-voids-and-card-refunds).
## Tickets and Guest orders
1. **Tickets** lists open tickets, refreshing about every 10 seconds. A time pill warns when a ticket has waited 15 minutes and again at 30. Press **Mark done** when the order has gone out. Use the **Outlet** filter to see one outlet.
2. **Guest orders** shows orders placed from QR codes. A guest order must be accepted here before it can be marked done on Tickets (until then it shows "Accept on Guest orders first").
3. Press **Accept** on a new order. When it is ready to go, press **Mark on the way**.
4. **Reject** needs a reason. The guest is not served, and any payment already taken (a card payment or a room charge) is reversed in full.
## You are done when
The sale is settled and its receipt is on the screen. Open tickets are marked done and guest orders are on their way.
## What can go wrong
- The Register will not let you sell: see [The Register will not let me sell](help:common-problems/register-will-not-sell).
- A refund or void asks for a manager: see [A refund or void asks for approval](help:common-problems/approval-pin-and-refunds).
- Card or NQR will not open: see [Online payments do not start](help:common-problems/online-payments-do-not-start).
- The tax on the ticket looks wrong: see [A tax is missing or wrong](help:common-problems/tax-missing-or-wrong).
