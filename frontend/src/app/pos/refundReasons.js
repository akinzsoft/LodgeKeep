/** The refund reason picker. Codes match the server's list (`backend/src/modules/pos/card-sale-refund.js`). */
export const REFUND_REASONS = [
  { code: 'customer_request', label: 'Customer requested a refund' },
  { code: 'wrong_charge', label: 'Wrong item or overcharged' },
  { code: 'duplicate_payment', label: 'Duplicate payment' },
  { code: 'service_issue', label: 'Service or quality complaint' },
  { code: 'order_cancelled', label: 'Order cancelled' },
  { code: 'other', label: 'Other (say why)' },
];
