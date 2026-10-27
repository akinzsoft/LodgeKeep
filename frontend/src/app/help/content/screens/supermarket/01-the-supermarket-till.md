---
images:
  - file: screens/supermarket/sell.webp
    alt: The Supermarket Sell tab with the scan box, product tiles, the current sale and the payment buttons
    caption: Supermarket → Sell. Scan or tap products, then choose how the customer pays
  - file: screens/supermarket/todays-sales.webp
    alt: The Today's sales tab with your sales for today and Reprint and Void buttons
    caption: Supermarket → Today's sales. Reprint a receipt or start a void
  - file: screens/supermarket/all-sales.webp
    alt: The All sales tab with a date range, totals and the list of sales
    caption: Supermarket → All sales (for people who can report)
---
# The supermarket till: selling, voiding and checking sales
## What it is for
The supermarket till rings up quick sales. You scan or tap products, take the payment, and print a receipt. Each sale gets its own receipt number, and stock goes down as you sell.
## Who can do this
- Selling and Today's sales need `supermarket.sales`. By default that is the POS operator, manager, admin and super admin roles.
- **All sales** needs `supermarket.report` (manager, admin, super admin by default).
- **Setup** and **Products import** need `supermarket.manage` (manager, admin, super admin).
- You only see the outlets you are assigned to. If none show, ask a manager to assign you in Setup → Staff.
- **A void and an oversell both need a manager's PIN.** The cashier starts, a manager types their own approval PIN at the till. See [The approval PIN and refunds](help:common-problems/approval-pin-and-refunds).
## Where to click
**Supermarket** in the sidebar. Choose the **Outlet** if you have more than one, then the tab: **Sell**, **Today's sales**, **All sales** (and **Request stock**, **Wastage**, **Setup**, **Products import** if you have those permissions).
## Fields that matter
1. **Add products.** Scan a barcode or type a product name in the box and press **Add**, or tap a product tile. The **Scan** button opens the phone camera for barcodes. A barcode adds the product at once. A name shows **Matching products** to tap. A product marked **Sold out** at this outlet is refused.
2. **The sale.** **Current sale** lists the lines. Use the **−** and **+** buttons to change quantities, and **Clear** to start again. Where stock is recorded, a line above stock shows **Only N in stock**.
3. **Discounts.** **Discount or comp** and **Voucher** are on the sale. If a discount needs a manager, the sale goes through at the full price until it is approved.
4. **Tax.** The sale shows **Items total**. Tax is added on the receipt using the supermarket VAT setting.
5. **Payment.** Choose **Cash**, **Card (terminal)** or **Online payment**, then press **Complete sale** (or **Take online payment**). For **Card (terminal)**, take the payment on your own terminal first. LodgeKeep does not charge the card.
6. **Online payment.** A window opens for Paystack. Choose **Pay in this window**, then **Check payment** once the customer has paid. **Cancel payment** stops it. The sale only completes when the payment is received.
7. **Receipt.** Press **Print receipt** or **Close**.
8. **Oversell prompt.** If the sale takes a product below its recorded stock, **Sell more than recorded stock?** lists the products. A manager types their PIN and presses **Sell anyway**. Stock then goes below zero and the sale is recorded with that manager.
9. **Today's sales.** Shows your own sales today with totals. **Reprint** shows the receipt again. **Void** starts a void.
10. **Void.** After you press **Void**, a manager types their PIN and presses **Void sale**. The sale is cancelled and its stock goes back. The receipt number is kept and shows **(void)**. An online payment is refunded in full to the customer through Paystack.
11. **All sales.** Choose **From** and **To** dates, or press **Today**, **Last 7 days** or **This month**. You see totals by payment method and the list of sales, each with **Receipt**. People who can sell can also void from here.
## You are done when
- The receipt shows with its number and the cart is empty.
- In **Today's sales** the sale appears with its total, and a voided sale shows **(void)**.
## What can go wrong
- **"You are not assigned to a supermarket outlet."** Ask a manager to assign you.
- **A barcode adds nothing, or "No product matches".** The product may not be on this till. A manager checks Supermarket → Setup.
- **The Scan button is missing.** The phone has no camera access, or the page is not on a secure connection.
- **An online payment is already waiting.** Finish or cancel it first. Only one can wait per cashier at each outlet.
- **The void or oversell asks for a PIN and the manager has none.** They set it in My Profile. If it is locked after wrong tries, wait about 15 minutes.
- **Offline.** Selling, voiding and payments are disabled until the connection returns.
