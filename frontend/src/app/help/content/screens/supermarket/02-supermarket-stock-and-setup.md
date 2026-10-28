---
images:
  - file: screens/supermarket/request-stock.webp
    alt: The Supermarket Request stock tab with the request form and the list of requests
    caption: Supermarket → Request stock. Ask the store for more; the store issues it
  - file: screens/supermarket/wastage.webp
    alt: The Supermarket Wastage tab with the Record wastage form
    caption: Supermarket → Wastage. Damaged or expired stock
  - file: screens/supermarket/setup.webp
    alt: The Supermarket Setup tab with products needing setup, the product list and the barcodes
    caption: Supermarket → Setup. Barcodes and products
  - file: screens/supermarket/products-import.webp
    alt: The Products import tab with the template download and file upload
    caption: Supermarket → Products import. Add many products from a spreadsheet
---
# Supermarket stock, setup and products import
## What it is for
This covers the supermarket tabs that look after products and stock: asking the store for more, recording wastage, fixing barcodes and prices, and loading products from a spreadsheet. Selling at the till is in [The supermarket till](help:screens/supermarket/01-the-supermarket-till).
## Who can do this
- **Request stock** needs `supermarket.sales` and `pos.stock_request` (POS operator, manager, admin, super admin by default).
- **Wastage** needs `supermarket.sales` and `pos.stock_view`.
- **Setup** and **Products import** need `supermarket.manage` (manager, admin, super admin by default).
- You only see outlets you are assigned to.
- None of these tabs asks for a manager PIN. A void and an oversell at the till do.
- The mart cannot add stock itself. After the first load, stock only rises when the store issues a request or transfer.
## Where to click
**Supermarket** in the sidebar, choose the **Outlet**, then **Request stock**, **Wastage**, **Setup** or **Products import**. The low-stock banner on the till also has a **Request stock** button.
## Fields that matter
1. **Request stock.** Ask the store for more. The store approves and issues it, and your request shows as pending until the store acts. "Deliver to" is fixed to your mart. Pick the items and quantities. The form works the same as in [Receiving, requesting and moving stock](help:screens/stock/02-receiving-requesting-and-moving-stock). You do not issue anything here.
2. **Wastage.** Pick the **Stock item**, the **Quantity lost** and a **Reason** (required), then **Record wastage**. Use it for damaged or expired stock.
3. **Setup: Products needing setup.** Lists products with **No barcode** or **Not stock-tracked**. They can still be sold, but a product that is not stock-tracked does not reduce stock. Type a barcode, or press **Scan** to use the camera, then **Add barcode**. A scanned barcode only fills the box. You press **Add barcode** yourself.
4. **Setup: Products.** Search by product or barcode and filter by **Category**. Change a **Price**, press **Edit** for the name, category and **Cost price**, or **Archive**. A product also sold at another outlet is locked here and marked "Also sold at …". Past sales keep the price they sold at. Archived products leave the till but stay in sales history.
5. **Setup: Barcodes.** Every barcode at the property, by product. Remove a wrong one (after a confirm), or add another to a product, for example a multipack. A barcode already used elsewhere is refused.
6. **Categories.** There is no category editor on the Supermarket tabs. A product's category is set when you edit it, or by the import. A new category in an import is created and carried by the mart. A category that a bar or restaurant already sells from is refused.
7. **Products import: get the file.** Press **Download template**. The columns are name, category, price, barcodes, unit, cost_price, opening_stock, reorder_level, supplier. Only name, category and price are required. Separate several barcodes with `|`.
8. **Products import: the rules.** Between 1 and 5,000 rows. No unknown or repeated column. Prices and costs have at most 2 decimals. A barcode already registered, or an active product with the same name in the same category, is an error, because the import only creates and never changes existing products. A cost price above zero is required when there is opening stock. A barcode that Excel turned into scientific notation (such as 5.449E+12) is refused, so format that column as Text.
9. **Dry run.** Choose the CSV and press **Check file**. Nothing is saved. You see **Products**, **New categories**, **Barcodes** and **Opening stock**, then **Problems to fix** and **Warnings**. While any problem exists nothing can be imported. Warnings do not stop it.
10. **Import.** When it says **Checked, not imported**, press **Import** and confirm. It is all or nothing: every row is created, or none are. Opening stock is received straight into the mart.
11. **Undo.** In **Past imports at this outlet** press **Undo** on an import and give a reason. Products nobody has sold, moved stock for or re-barcoded since are deleted with their opening stock. Any that have been used are kept and listed.
## You are done when
A request shows **Issued**, a barcode appears under the product's name, or an import shows **Imported** with the number of products. Scan one imported product at the till to confirm it is found.
## What can go wrong
- The import is full of problems: fix the rows in your spreadsheet and start again. Only one import can be committing at a time for the property.
- A product is not in stock-tracking: it needs a stock item behind it. Imported products have one.
- A sale is blocked for stock or you are asked to confirm selling more than recorded: see [Stock is wrong or an item shows Sold out](help:common-problems/stock-is-wrong-or-sold-out).
