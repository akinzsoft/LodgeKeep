---
images:
  - file: screens/pos-stock/stock-items.webp
    alt: The Stock items tab with the outlet picker, stock categories and the table of stock items
    caption: POS → Stock → Stock items. On hand, reorder level, cost and whether the item is sold in the Register
  - file: screens/pos-stock/recipes.webp
    alt: The Recipes tab where a menu item is linked to the stock items it uses
    caption: POS → Stock → Recipes. What one sale of a menu item takes out of stock
  - file: screens/pos-stock/reorder-report.webp
    alt: The Reorder report listing out-of-stock and low-stock items
    caption: POS → Stock → Reorder report. What is out or low right now
---
# Stock items, recipes and the reorder report
## What it is for
A **stock item** is a thing you hold and count, such as a bottle, a kilo or a packet. This guide covers adding and editing stock items, linking them to what the Register sells (recipes), and seeing what is running low.
## Who can do this
- The **Stock items** and **Reorder report** tabs need `pos.stock_view`. By default that is the POS operator, storekeeper, manager, admin and super admin.
- Adding, editing, archiving, **Receive**, **Sell in Register** and the **Recipes** tab need `pos.stock_manage`. By default that is manager, admin and super admin.
- **Changing an item's cost price** needs `pos.stock_cost_edit`. By default that is manager, admin and super admin. Without it you see the cost as text and a note "Changing it needs a manager".
- A tab you cannot use is not shown to you. A storekeeper sees Stock items, Requests, Transfer, Wastage and Reorder report.
- Nothing on these tabs asks for a manager PIN.
## Where to click
POS → **Stock**, then **Stock items**, **Recipes** or **Reorder report**. A storekeeper has a **Stock** item in the sidebar instead.
## Fields that matter
1. **Outlet.** Pick the outlet at the top of Stock items. Stock items are shared by every outlet, but the quantity and reorder level you see belong to that outlet. **Low stock only** shows only items at or below their reorder level.
2. **Stock categories.** Add, rename or archive categories in the card above the table. Renaming changes every stock item in that category. A category that still has items cannot be archived. Click a category to see its items.
3. **Add item.** Press **Add item** under the category. Fill in **Name**, **Unit** (for example ml, bottle, kg), and if you wish **Initial cost**, **Supplier** and **Reorder level**. You can tick **Also sell in Register** to create the Register item at the same time.
4. **Edit.** Press **Edit** to change the name, unit, **Stock category**, **Supplier** and **Reorder level**. The quantity on hand cannot be typed here. It only changes through a delivery, a request or transfer, a sale, wastage or a stock take.
5. **Cost price.** With `pos.stock_cost_edit` you also see **Cost price**. If you change it a **Reason for the cost change** appears and is needed. Past sales keep the cost they were recorded with. The new cost applies to future sales and to the margin report.
6. **Receive.** The row button **Receive** records one delivery for that item. It only appears at a store room. See [Receiving, requesting and moving stock](help:screens/stock/02-receiving-requesting-and-moving-stock).
7. **Register column.** Each item shows **In Register**, **Ingredient only** or **Not sold**. Press **Sell in Register** on a **Not sold** item to make a menu item for it. You choose its price, category and how much one sale uses.
8. **Archive.** **Archive** hides an item from lists and pickers. Its past movement history stays.
9. **Recipes tab.** Choose an **Outlet** and a **Menu item**. Under **Add stock item** pick the item and a **Quantity**, press **Add to recipe**, then **Save recipe**. The quantity is what one sale uses. A menu item with no recipe never reduces stock when it sells.
10. **Reorder report.** Choose an **Outlet** (or All outlets) and **Show** either "Out of stock and low stock", "Out of stock only" or "Low stock only". It shows the live position, with no date range. **To reorder (at least)** is the amount needed to get back up to the reorder level. It is a minimum, not a suggested order size. **Refresh** reloads it.
## You are done when
The item shows in the table with the right unit and reorder level, and a menu item that sells it shows **In Register**. For a recipe, you see "Recipe saved." For the reorder report, the out and low counts above the table match what you expect.
## What can go wrong
- An item is **Out of stock** or **Sold out**: see [Stock is wrong or an item shows Sold out](help:common-problems/stock-is-wrong-or-sold-out).
- You cannot change the cost: you do not hold `pos.stock_cost_edit`. Ask a manager.
- You get no **Receive** button: this outlet is not the store room. Use a request instead.
- A cost that is as high as the selling price: see the cost check in [Stock reports](help:screens/stock/04-stock-reports).
