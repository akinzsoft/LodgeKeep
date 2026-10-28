---
images:
  - file: screens/pos-stock/stock-takes.webp
    alt: The Stock takes tab with the Open a new stock take form and the list of stock takes
    caption: POS → Stock → Stock takes. Open a count, enter what you counted, then complete it
  - file: screens/pos-stock/wastage.webp
    alt: The Wastage tab with the Record wastage form
    caption: POS → Stock → Wastage. Record stock that was lost, broken or spoiled
---
# Stock takes and wastage
## What it is for
A **stock take** is a physical count. LodgeKeep compares what you counted with what it thinks is there, and the difference is a variance. **Wastage** records stock that was lost, broken or spoiled so the numbers stay honest.
## Who can do this
- **Stock takes** need `pos.stock_manage` (manager, admin, super admin by default).
- **Wastage** needs `pos.stock_view` (POS operator, storekeeper, manager, admin, super admin by default).
- Neither asks for a manager PIN.
## Where to click
POS → **Stock**, then **Stock takes** or **Wastage**. A supermarket cashier records wastage under Supermarket → **Wastage**.
## Fields that matter
1. **Open a count.** In **Stock takes**, under **Open a new stock take**, pick the **Outlet** and press **Open stock take**. The new take appears in the **Stock takes** list with the status **Open**.
2. **Count blind.** Press **View** on the take to open it. For each item type the **Counted quantity** and press **Save count** on its row. The screen says "Nothing here shows what the system expects until this take is completed." You do not see the system quantity.
3. **A count cannot raise stock.** At a bar, restaurant or mart, when the property has a store room, a count can confirm or lower the stock but not raise it. Stock arrives from the store by a request or transfer. If you counted more than the system holds, completing is refused, naming the items. The take stays open, nothing is written, and you can re-count lower. At the store room itself, a count can be higher.
4. **Complete.** Press **Complete stock take** and confirm. It locks the count and posts real adjusting stock movements for any variance. That cannot be undone.
5. **Cancel.** **Cancel stock take** needs a reason. It abandons the count with no effect on stock, and what you typed is thrown away.
6. **Read the result.** A completed take shows **Counted**, **Theoretical** and **Variance** for each item. **Theoretical** is what the system held at that outlet. **Variance** is counted minus theoretical. A negative variance means fewer than expected (lost, wasted without being recorded, or not recorded when used). A positive one means more than expected, which is only possible where raising is allowed.
7. **Record wastage.** In **Wastage**, pick the **Outlet** (fixed at the mart), the **Stock item**, the **Quantity lost** and a **Reason**. Press **Record wastage**. A reason is required. You then see how much of the item is on hand at that outlet.
8. **What wastage does.** It takes the quantity out of stock at that outlet and appears in the stock reports as wastage cost.
## You are done when
A take shows **Completed** and its Result table lists the variances. For wastage, the "Recorded" card shows the new on-hand figure.
## What can go wrong
- Completing is refused because you counted too high: re-count, or ask the store to transfer the difference first. See [Stock is wrong or an item shows Sold out](help:common-problems/stock-is-wrong-or-sold-out).
- A large negative variance: look at [Stock reports](help:screens/stock/04-stock-reports) for sales, wastage and transfers over the same dates.
- You cannot open the Stock takes tab: it needs `pos.stock_manage`.
