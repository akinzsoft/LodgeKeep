'use strict';

// Preloaded into the child process (node --require) so the real script entry runs with a stubbed Paystack.
global.fetch = async () => ({
  json: async () => ({
    status: true,
    data: { reference: 'ref_1', status: 'success', channel: 'card', amount: 1000000, requested_amount: 1000000, fees: 15000, subaccount: { subaccount_code: 'ACCT_x', percentage_charge: 0 } },
  }),
});
