---
images:
  - file: screens/pos-stock/goods-received.webp
    alt: The Goods received tab with the New delivery form and the recent deliveries table
    caption: POS → Stock → Goods received. Record a supplier delivery at the store room
  - file: screens/pos-stock/requests.webp
    alt: The Requests tab with the Request stock form and the list of stock requests
    caption: POS → Stock → Requests. An outlet asks, the store issues
  - file: screens/pos-stock/transfer.webp
    alt: The Transfer tab with the From, To, Stock item and Quantity fields
    caption: POS → Stock → Transfer. Move stock straight from one outlet to another
---
# Receiving, requesting and moving stock
## What it is for
Stock comes into the building through the **store room**. From there it reaches a bar, restaurant or mart by a **request** that the storekeeper issues, or by a direct **transfer**. This guide explains each, who can do it, and what happens to quantity and cost.
## Who can do this
- **Goods received** needs `pos.stock_manage` (manager, admin, super admin by default).
- **Requests**: raising or withdrawing a request needs `pos.stock_request` (POS operator, manager, admin, super admin). **Issuing or rejecting** a request needs `pos.stock_transfer`. The tab opens for either permission.
- **Transfer** needs `pos.stock_transfer` (storekeeper, manager, admin, super admin).
- None of these three asks for a manager PIN.
- If you are assigned to particular outlets (Setup → Staff → Outlets), you can only raise requests for those outlets and only see requests to or from them.
## Where to click
POS → **Stock**, then **Goods received**, **Requests** or **Transfer**. A storekeeper finds the same tabs under **Stock** in the sidebar.
## Fields that matter
1. **Receive a delivery (store room only).** In **Goods received** choose the **Outlet**. If the property has a store room, only the store is allowed. Under **New delivery** enter a **Reference (optional)**, for example the delivery note number. For each line pick the **Stock item**, a **Quantity** and a **Unit cost**. Use **Add another line** for more, and **Record delivery**.
2. **What a delivery does.** The quantity at the store goes up. The item's cost becomes this delivery's unit cost, so it replaces the earlier cost. The result card shows each item's **New quantity on hand** and **New cost**. **Recent deliveries** lists what was recorded.
3. **The store-only rule.** If the property has an active store room, receiving at a bar, restaurant or mart is refused: "Goods are received at the store room … not at …". Receive at the store, then move it. A property with no store room can still receive at its outlets.
4. **Request stock.** In **Requests**, open **Request stock**. Choose **Request from** (normally the store) and **Deliver to**. Pick up to several items with a quantity each. The screen shows how much the store holds. Add a **Note (optional)** and send it. The store is alerted.
5. **The store decides.** The storekeeper opens the request, changes the **Send** amount for each line (any amount up to what was asked, including 0), and presses **Issue**. The stock moves the moment it is issued. There is no receipt step. They can also **Reject** with a reason, which tells the outlet.
6. **Short issues.** If the store sent less, the request shows "Sent short" and the requester can press **Request the rest**. That opens a new request for only the missing amounts. Only one live top-up per request is allowed.
7. **Withdraw.** The person who asked can press **Withdraw** on a pending request. A request is decided once. After it is issued or rejected, raise a new one.
8. **Transfer.** In **Transfer** pick **From**, **To**, **Stock item**, **Quantity** and an optional **Note**. It shows how much is on hand at the source. Press **Transfer**. The stock arrives straight away at the item's current cost.
9. **A transfer never goes below zero.** If the source holds less than you ask for, it is refused and nothing moves. Recent transfers are listed underneath.
10. **Costs.** A transfer moves stock at the item's current cost. A delivery is the only action on these tabs that sets a new cost.
## You are done when
For a delivery, you see "Delivery recorded" and the new quantity. For a request, it shows **Issued** (or **Rejected**). For a transfer, you see "Transfer recorded" and both outlets' new quantities.
## What can go wrong
- The delivery is refused at a bar: this is the store-only rule. See [Stock is wrong or an item shows Sold out](help:common-problems/stock-is-wrong-or-sold-out).
- "Only N is on hand … cannot transfer": the source does not hold that much. Lower the quantity or receive more at the store first.
- You cannot see a request: you may not be assigned to that outlet.
- Adding the item itself: see [Stock items, recipes and the reorder report](help:screens/stock/01-stock-items-recipes-and-reorder).
