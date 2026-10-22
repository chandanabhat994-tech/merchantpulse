import { understand } from './understand.js';
import { rulePlan } from './planner.js';
import { llmPlan } from './llmPlanner.js';
import { evaluatePolicy, ACTIONS, DECISIONS } from './policy.js';

export const OUTCOMES = {
  NEEDS_INFO: 'NEEDS_INFO',
  EXPLAINED: 'EXPLAINED',                     // verified: status explained, nothing to change
  TICKET_OPENED: 'TICKET_OPENED',             // verified ticket exists
  ESCALATED: 'ESCALATED',                     // handed to a human with evidence
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',     // financial action waiting for a human
  REFUNDED: 'REFUNDED',                       // approved and verified
  REFUND_REJECTED: 'REFUND_REJECTED',
  UNVERIFIED: 'UNVERIFIED',                   // could not confirm the effect; escalated, never claimed as success
};

const MAX_ATTEMPTS = 3;

/**
 * Runs one support case end to end:
 * understand -> investigate -> plan -> policy -> act (retry, idempotent) -> verify -> reply
 */
export async function runCase(message, { api, store, retryDelayMs = 0, llmFetch = fetch }) {
  const c = {
    id: store.nextId(),
    message,
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    intent: null,
    evidence: {},
    plan: null,
    policy: null,
    steps: [],
    audit: [],
    ticket: null,
    pendingApproval: null,
    outcome: null,
    reply: null,
  };
  store.put(c);

  const log = (type, detail) => {
    const entry = { at: new Date().toISOString(), type, detail };
    c.audit.push(entry);
    store.put(c);
  };
  const step = (tool, args, result, ok = true, error = null) => {
    c.steps.push({ tool, args, ok, error, result: summarize(result) });
    log('tool_call', { tool, args, ok, error });
  };

  // 1. Understand
  c.intent = understand(message);
  log('understand', c.intent);

  // 2. Investigate (read-only)
  const read = (tool, args, fn) => {
    try {
      const result = fn();
      step(tool, args, result);
      return result;
    } catch (err) {
      step(tool, args, null, false, err.message);
      return null;
    }
  };

  if (c.intent.merchantId) {
    c.evidence.merchant = read('getMerchant', { merchantId: c.intent.merchantId }, () => api.getMerchant(c.intent.merchantId));
  }
  if (c.intent.txnId) {
    c.evidence.transaction = read('getTransaction', { txnId: c.intent.txnId }, () => api.getTransaction(c.intent.txnId));
    if (c.evidence.transaction) {
      c.evidence.merchant ??= read('getMerchant', { merchantId: c.evidence.transaction.merchantId },
        () => api.getMerchant(c.evidence.transaction.merchantId));
      c.evidence.settlement = read('findSettlementForTxn', { txnId: c.intent.txnId },
        () => api.findSettlementForTxn(c.intent.txnId));
      c.evidence.openTickets = read('searchTickets', { txnId: c.intent.txnId, openOnly: true },
        () => api.searchTickets({ txnId: c.intent.txnId, openOnly: true })) ?? [];
    }
  }

  // 3. Plan: LLM proposes (validated), rules are the fallback
  const planInput = {
    intent: c.intent,
    transaction: c.evidence.transaction,
    settlement: c.evidence.settlement,
    existingTicket: c.evidence.openTickets?.[0] ?? null,
  };
  let plan = await llmPlan({ ...planInput, merchant: c.evidence.merchant }, llmFetch);
  if (!plan) plan = rulePlan(planInput);
  c.plan = plan;
  log('plan', plan);

  // 4. Policy gate
  let policy = evaluatePolicy(plan.action, { merchant: c.evidence.merchant, transaction: c.evidence.transaction, settlement: c.evidence.settlement });
  if (policy.decision === DECISIONS.DENY) {
    c.plan = { action: ACTIONS.ESCALATE_TO_HUMAN, reason: `${plan.action} denied by policy (${policy.reason})` };
    policy = evaluatePolicy(ACTIONS.ESCALATE_TO_HUMAN, {});
    log('policy_override', { denied: plan.action, reason: policy.reason });
  }
  c.policy = policy;
  log('policy', policy);

  // 5. Act + 6. Verify
  const action = c.plan.action;
  try {
    if (action === ACTIONS.ASK_FOR_INFO) {
      c.outcome = OUTCOMES.NEEDS_INFO;
    } else if (action === ACTIONS.EXPLAIN_STATUS) {
      const txn = read('getTransaction', { txnId: c.intent.txnId }, () => api.getTransaction(c.intent.txnId));
      const settlement = txn?.settlementId ? read('getSettlement', { settlementId: txn.settlementId }, () => api.getSettlement(txn.settlementId)) : null;
      // A refunded transaction is explained by its refund state, not by settlement
      c.outcome = txn && (settlement || txn.status === 'REFUNDED') ? OUTCOMES.EXPLAINED : OUTCOMES.UNVERIFIED;
    } else if (action === ACTIONS.OPEN_INVESTIGATION_TICKET || action === ACTIONS.ESCALATE_TO_HUMAN) {
      const type = action === ACTIONS.ESCALATE_TO_HUMAN ? 'ESCALATION' : 'INVESTIGATION';
      const ticket = await createTicketWithRecovery({ c, api, type, retryDelayMs, log });
      if (!ticket) {
        c.outcome = OUTCOMES.UNVERIFIED;
      } else {
        const verified = read('getTicket', { ticketId: ticket.id }, () => api.getTicket(ticket.id));
        const ok = verified && verified.status === 'OPEN' && verified.txnId === c.intent.txnId;
        log('verify_ticket', { ticketId: ticket.id, verified: Boolean(ok) });
        if (!ok) c.outcome = OUTCOMES.UNVERIFIED;
        else c.outcome = type === 'ESCALATION' ? OUTCOMES.ESCALATED : OUTCOMES.TICKET_OPENED;
      }
    } else if (action === ACTIONS.REQUEST_REFUND_APPROVAL) {
      c.pendingApproval = { type: 'REFUND', txnId: c.intent.txnId, amount: c.evidence.transaction.amount };
      c.outcome = OUTCOMES.APPROVAL_REQUIRED;
      log('approval_requested', c.pendingApproval);
    }
  } catch (err) {
    log('error', { message: err.message });
    c.outcome = OUTCOMES.UNVERIFIED;
  }

  // Anything that could not be verified is escalated, never reported as success
  if (c.outcome === OUTCOMES.UNVERIFIED) {
    c.plan = { ...c.plan, escalatedAfterFailure: true };
    const ticket = await createTicketWithRecovery({ c, api, type: 'ESCALATION', retryDelayMs, log }).catch(() => null);
    if (ticket) c.ticket = ticket;
  }

  c.reply = composeReply(c);
  c.status = c.outcome;
  log('outcome', { outcome: c.outcome });
  store.put(c);
  return c;
}

/** Idempotent ticket creation with bounded retries for transient failures. */
async function createTicketWithRecovery({ c, api, type, retryDelayMs, log }) {
  const txnId = c.intent.txnId;
  const existing = c.evidence.openTickets?.find((t) => t.type === type);
  if (existing) {
    log('dedupe', { reusedTicketId: existing.id, reason: 'Open ticket already exists for this transaction' });
    c.ticket = existing;
    return existing;
  }
  const idempotencyKey = `${txnId}:${type}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const ticket = api.createTicket({
        idempotencyKey,
        merchantId: c.evidence.transaction?.merchantId ?? c.intent.merchantId,
        txnId,
        type,
        summary: `${type} for ${txnId}: ${c.message.slice(0, 200)}`,
      });
      log('tool_call', { tool: 'createTicket', args: { idempotencyKey, attempt }, ok: true, result: { id: ticket.id, replayed: ticket.replayed } });
      c.ticket = ticket;
      return ticket;
    } catch (err) {
      log('tool_call', { tool: 'createTicket', args: { idempotencyKey, attempt }, ok: false, error: err.message });
      if (!err.transient || attempt === MAX_ATTEMPTS) return null;
      if (retryDelayMs) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }
  return null;
}

/** Applies a human decision to a pending refund. Only approved refunds touch money. */
export function decideApproval(caseId, { api, store, approve }) {
  const c = store.get(caseId);
  if (!c) throw Object.assign(new Error('case not found'), { status: 404 });
  if (c.outcome !== OUTCOMES.APPROVAL_REQUIRED) {
    throw Object.assign(new Error(`case is ${c.outcome}, not awaiting approval`), { status: 409 });
  }
  const log = (type, detail) => { c.audit.push({ at: new Date().toISOString(), type, detail }); store.put(c); };
  if (!approve) {
    c.outcome = OUTCOMES.REFUND_REJECTED;
    log('approval_decision', { approved: false });
  } else {
    const txn = api.applyRefund(c.pendingApproval.txnId, c.id);
    const verified = api.getTransaction(c.pendingApproval.txnId);
    log('approval_decision', { approved: true });
    log('verify_refund', { txnId: txn.id, status: verified.status, verified: verified.status === 'REFUNDED' });
    c.outcome = verified.status === 'REFUNDED' ? OUTCOMES.REFUNDED : OUTCOMES.UNVERIFIED;
  }
  c.status = c.outcome;
  c.reply = composeReply(c);
  store.put(c);
  return c;
}

function composeReply(c) {
  const txn = c.intent.txnId ?? 'your transaction';
  switch (c.outcome) {
    case OUTCOMES.NEEDS_INFO:
      return 'I could not find a transaction reference in your message. Please share the transaction ID (for example TXN1001) so I can investigate.';
    case OUTCOMES.EXPLAINED:
      if (c.evidence.transaction?.status === 'REFUNDED') {
        return `I checked ${txn}. It has already been refunded, as confirmed in the records. No further action is needed.`;
      }
      return `I checked ${txn}. It was successful and is linked to settlement ${c.evidence.settlement?.id ?? c.steps.find((s) => s.tool === 'getTransaction')?.result?.settlementId}. No action is needed; the status is confirmed in the records.`;
    case OUTCOMES.TICKET_OPENED:
      return `I investigated ${txn} and found: ${c.plan.reason}. I opened investigation ticket ${c.ticket?.id} and confirmed it exists and is open. The support team will follow up.`;
    case OUTCOMES.ESCALATED:
      return `${txn} needs a human decision: ${c.plan.reason}. I created escalation ticket ${c.ticket?.id}, which includes the evidence I collected.`;
    case OUTCOMES.APPROVAL_REQUIRED:
      return `Refund for ${txn} requires human approval before any money moves. I have sent it for review; no refund has been made yet.`;
    case OUTCOMES.REFUNDED:
      return `The refund for ${txn} was approved and I verified that its status is now REFUNDED.`;
    case OUTCOMES.REFUND_REJECTED:
      return `The refund request for ${txn} was rejected by a reviewer. No money was moved.`;
    case OUTCOMES.UNVERIFIED:
    default:
      return `I could not verify the result for ${txn} automatically, so I have escalated it to a human agent rather than reporting success.`;
  }
}

function summarize(result) {
  if (result == null) return null;
  if (Array.isArray(result)) return { count: result.length };
  return result;
}
