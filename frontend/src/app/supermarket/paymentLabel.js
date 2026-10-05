/** How a supermarket sale was paid, in words. `method` is cash | terminal | card; card is the online (Paystack) sale. */
export function paymentLabel(sale) {
  if (sale?.method === 'terminal') return 'Card (terminal)';
  // card = an online (Paystack) sale; the channel is what the customer actually used (bank transfer, card, ...).
  if (sale?.method === 'card') return sale.payment_channel ? `Online payment (${sale.payment_channel.replace(/_/g, ' ')})` : 'Online payment (Paystack)';
  return 'Cash';
}
