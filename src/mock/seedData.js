// Synthetic, deterministic seed data. Nothing here is real Paytm data.
export function buildSeed() {
  const merchants = {
    M001: { id: 'M001', name: 'Sunrise Cafe', status: 'ACTIVE', kycVerified: true, city: 'Bengaluru' },
    M002: { id: 'M002', name: 'Kiran Textiles', status: 'ACTIVE', kycVerified: true, city: 'Surat' },
    M003: { id: 'M003', name: 'QuickMart Electronics', status: 'SUSPENDED', kycVerified: true, city: 'Pune' },
  };

  const txnList = [
    // Successful, no settlement link yet -> the "paid but missing" case
    { id: 'TXN1001', merchantId: 'M001', amount: 2500, status: 'SUCCESS', settlementId: null,  createdAt: '2026-10-20T10:12:00+05:30' },
    // Successful and already paid out -> status explained by settlement
    { id: 'TXN1002', merchantId: 'M001', amount: 1200, status: 'SUCCESS', settlementId: 'S501', createdAt: '2026-10-18T14:03:00+05:30' },
    // Failed at the gateway -> customer may claim they were charged
    { id: 'TXN1003', merchantId: 'M002', amount: 4800, status: 'FAILED',  settlementId: null,  createdAt: '2026-10-21T09:45:00+05:30' },
    // Successful but settlement is on risk hold -> must escalate to a human
    { id: 'TXN1004', merchantId: 'M002', amount: 3100, status: 'SUCCESS', settlementId: 'S502', createdAt: '2026-10-19T16:20:00+05:30' },
    // Merchant is suspended -> do not act autonomously
    { id: 'TXN1005', merchantId: 'M003', amount: 9900, status: 'SUCCESS', settlementId: null,  createdAt: '2026-10-21T11:30:00+05:30' },
    // Successful, settlement pending, recent -> status refresh is enough
    { id: 'TXN1006', merchantId: 'M001', amount: 750,  status: 'SUCCESS', settlementId: 'S503', createdAt: '2026-10-22T08:05:00+05:30' },
  ];

  const settlements = {
    S501: { id: 'S501', merchantId: 'M001', status: 'PAID',    amount: 1200, txnIds: ['TXN1002'], payoutDate: '2026-10-19' },
    S502: { id: 'S502', merchantId: 'M002', status: 'ON_HOLD', amount: 3100, txnIds: ['TXN1004'], payoutDate: null, holdReason: 'Risk review' },
    S503: { id: 'S503', merchantId: 'M001', status: 'PENDING', amount: 750,  txnIds: ['TXN1006'], payoutDate: null },
  };

  return {
    merchants,
    transactions: Object.fromEntries(txnList.map((t) => [t.id, t])),
    settlements,
    tickets: [],
  };
}
