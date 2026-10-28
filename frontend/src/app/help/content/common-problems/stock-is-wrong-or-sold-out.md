# Stock is wrong or an item shows Sold out

## Symptoms
An item shows **Out of stock** or **Sold out**, a quantity is negative, a delivery or a stock take is refused, or the supermarket asks "Sell more than recorded stock?".

## What to check
1. **Negative stock is allowed on purpose.** A sale or wastage can take recorded stock below zero. It means the records are behind reality. A delivery, a stock take or a transfer from the store fixes it. See [Stock items, recipes and the reorder report](help:screens/stock/01-stock-items-recipes-and-reorder).
2. **Sold out at a bar or restaurant.** When stock reaches zero the item is switched off for sale at that outlet. Once stock is added back it should be offered again. A manager can also hold it off by hand, which stays until changed. In the Register, adding more than is recorded asks for a manager's PIN.
3. **"Goods are received at the store room, not at …".** The property has a store room, so deliveries can only be recorded there. Receive at the store, then move the stock with a request or transfer. See [Receiving, requesting and moving stock](help:screens/stock/02-receiving-requesting-and-moving-stock).
4. **"Only N is on hand … cannot transfer".** A transfer can never take the source below zero. Lower the amount, or receive more at the source first.
5. **A stock take is refused because you counted too high.** At a bar, restaurant or mart, a count cannot raise stock. Re-count, or ask the store to transfer the difference. The take stays open. See [Stock takes and wastage](help:screens/stock/03-stock-takes-and-wastage).
6. **Supermarket: "Sell more than recorded stock?".** The till tells you which products would go below zero. A manager approves with their own PIN and the sale is recorded with them. A supermarket product is never switched off just because stock ran out. A product marked Sold out by hand still blocks. Ask the store for more through **Request stock**. See [Supermarket stock, setup and products import](help:screens/supermarket/02-supermarket-stock-and-setup).
7. **Sales not reducing stock.** An item with no recipe (Register) or no stock tracking (supermarket) takes nothing out when it sells. Add the recipe or the stock link.
8. **Does a cost look wrong?** See the cost check in [Stock reports](help:screens/stock/04-stock-reports).

## Still stuck
Note the item, the outlet and the figure you expected, then ask a manager to check Reports → Stock movements for that outlet. If a manager PIN is refused, see [A refund or void asks for approval](help:common-problems/approval-pin-and-refunds).
