---
images:
  - file: screens/pos-stock/reports.webp
    alt: The stock Reports tab with the date range, the stock category summary and the cost of sales tables
    caption: POS → Stock → Reports. Cost of sales, margin and the cost check
---
# Stock reports: cost of sales, margin and the cost check
## What it is for
The **Reports** tab shows what stock cost you, what it earned, and where a cost looks wrong. Use it to see how stock moved and whether items are priced sensibly.
## Who can do this
- The Reports tab needs `pos.stock_manage`. By default that is manager, admin and super admin.
- Nothing here changes stock or money, and nothing asks for a manager PIN.
- Fixing a wrong cost needs `pos.stock_cost_edit` on the Stock items tab.
## Where to click
POS → **Stock** → **Reports**. Choose an **Outlet** (or All outlets), set **From** and **To**, and press **Run reports**.
## Fields that matter
1. **Cost check.** At the top is the card "Cost check — items costed at or above their selling price". It lists menu items whose recipe cost is as high as, or higher than, their price. The note says this is usually a mistyped stock cost. Fix it under Stock items → Edit → Cost price. It is empty with the message "No item costs as much as it sells for" when nothing is wrong.
2. **Stock categories — summary.** Per category: **Items**, **Low / out of stock**, **Cost of sales**, **Wastage**, **Transferred in** and **Transferred out**. Every active stock item and category shows, including ones with no movement.
3. **Every stock item — by stock category.** Per item: **On hand**, **Sold**, **Cost of sales**, **Received**, **Wasted**, **Transferred in**, **Transferred out** and **Count adjustment**.
4. **Stock movements.** With an outlet chosen you also see each movement, including Register sales, with its **Date**, **Type** and **Quantity**. Only the latest 200 are shown, so narrow the dates to see earlier ones.
5. **Cost of sales.** By day and by stock item. The total is the cost of the stock that sales used.
6. **Stock variance.** The total variance per item over every stock take completed in the range. See [Stock takes and wastage](help:screens/stock/03-stock-takes-and-wastage).
7. **Cost-of-sales margin.** By menu item and by menu category: **Qty sold**, **Revenue**, **Cost**, **Margin** and **Margin %**. Cost comes from the recipe. If there is no recipe it uses the item's cost price, and if neither is set the cost is shown as unknown. Those items are left out of the cost and margin totals, and the note says how many.
8. **Cost is today's cost.** The reports use the current recipe and cost, so older periods can change if a cost is later corrected.
## You are done when
The tables fill after **Run reports**, the cost check is empty or you have a list to fix, and the totals match what you expect for the dates.
## What can go wrong
- Margin is unexpectedly high: some items have unknown cost. Add a recipe or a cost price.
- Cost of sales looks too big for one item: use the cost check and correct the stock cost. See [Stock items, recipes and the reorder report](help:screens/stock/01-stock-items-recipes-and-reorder).
- Quantities do not match a count: see [Stock is wrong or an item shows Sold out](help:common-problems/stock-is-wrong-or-sold-out).
