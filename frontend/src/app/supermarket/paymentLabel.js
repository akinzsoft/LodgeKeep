/** How a supermarket sale was paid, in words. `method` is cash | terminal | card; card is the online (Paystack) sale. */
export function paymentLabel(sale) {
  if (sale?.method === 'terminal') return 'Card (terminal)';
  if (sale?.method === 'card') return sale.payment_channel && sale.payment_channel !== 'card' ? `Card (online, ${sale.payment_channel.replace('_', ' ')})` : 'Card (online)';
  return 'Cash';
}
