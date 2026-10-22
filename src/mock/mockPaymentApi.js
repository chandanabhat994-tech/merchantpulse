import { buildSeed } from './seedData.js';

/**
 * Mock payment platform. Mirrors the shape of read APIs (transactions,
 * settlements, merchants) and a support-ticket write API. Supports failure
 * injection so the recovery path can be demonstrated deterministically.
 */
export class MockPaymentApi {
  constructor(seed = buildSeed()) {
    this.seed = seed;
    this.failures = { createTicket: 0 }; // number of upcoming calls to fail
    this.callLog = [];
  }

  reset(seed = buildSeed()) {
    this.seed = seed;
    this.failures = { createTicket: 0 };
    this.callLog = [];
  }

  injectFailure(op, times = 1) {
    this.failures[op] = times;
  }

  _record(op, args, ok) {
    this.callLog.push({ op, args, ok, at: new Date().toISOString() });
  }

  _maybeFail(op) {
    if (this.failures[op] > 0) {
      this.failures[op] -= 1;
      const err = new Error(`${op} temporarily unavailable (HTTP 503)`);
      err.transient = true;
      throw err;
    }
  }

  getTransaction(txnId) {
    const txn = this.seed.transactions[txnId];
    this._record('getTransaction', { txnId }, Boolean(txn));
    return txn ? { ...txn } : null;
  }

  getMerchant(merchantId) {
    const m = this.seed.merchants[merchantId];
    this._record('getMerchant', { merchantId }, Boolean(m));
    return m ? { ...m } : null;
  }

  getSettlement(settlementId) {
    const s = this.seed.settlements[settlementId];
    this._record('getSettlement', { settlementId }, Boolean(s));
    return s ? { ...s, txnIds: [...s.txnIds] } : null;
  }

  findSettlementForTxn(txnId) {
    const s = Object.values(this.seed.settlements).find((x) => x.txnIds.includes(txnId));
    this._record('findSettlementForTxn', { txnId }, Boolean(s));
    return s ? { ...s, txnIds: [...s.txnIds] } : null;
  }

  searchTickets({ txnId, merchantId, openOnly = false } = {}) {
    const results = this.seed.tickets
      .filter((t) => (!txnId || t.txnId === txnId))
      .filter((t) => (!merchantId || t.merchantId === merchantId))
      .filter((t) => (!openOnly || t.status === 'OPEN'))
      .map((t) => ({ ...t }));
    this._record('searchTickets', { txnId, merchantId, openOnly }, true);
    return results;
  }

  getTicket(ticketId) {
    const t = this.seed.tickets.find((x) => x.id === ticketId);
    this._record('getTicket', { ticketId }, Boolean(t));
    return t ? { ...t } : null;
  }

  /** Idempotent: the same idempotencyKey never produces a second ticket. */
  createTicket({ idempotencyKey, merchantId, txnId, type, summary }) {
    this._maybeFail('createTicket');
    const existing = this.seed.tickets.find((t) => t.idempotencyKey === idempotencyKey);
    if (existing) {
      this._record('createTicket', { idempotencyKey, replay: true }, true);
      return { ...existing, replayed: true };
    }
    const ticket = {
      id: `TKT-${String(this.seed.tickets.length + 1).padStart(4, '0')}`,
      idempotencyKey,
      merchantId,
      txnId: txnId ?? null,
      type,
      summary,
      status: 'OPEN',
      createdAt: new Date().toISOString(),
    };
    this.seed.tickets.push(ticket);
    this._record('createTicket', { idempotencyKey }, true);
    return { ...ticket, replayed: false };
  }

  /** Consequential write. Only ever called after a human approves it. Idempotent. */
  applyRefund(txnId, approvalId) {
    const txn = this.seed.transactions[txnId];
    if (!txn) throw new Error(`transaction ${txnId} not found`);
    if (txn.status === 'REFUNDED') {
      this._record('applyRefund', { txnId, approvalId, replay: true }, true);
      return { ...txn, replayed: true };
    }
    txn.status = 'REFUNDED';
    txn.refundApprovalId = approvalId;
    this._record('applyRefund', { txnId, approvalId }, true);
    return { ...txn, replayed: false };
  }
}
