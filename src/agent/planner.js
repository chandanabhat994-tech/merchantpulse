import { ACTIONS } from './policy.js';

/**
 * Rule planner: deterministic baseline. Chooses one candidate action from the
 * gathered evidence. Used by default, and as the fallback whenever the LLM
 * planner is unavailable or proposes something invalid.
 */
export function rulePlan({ intent, transaction, settlement, existingTicket }) {
  if (!intent.txnId) {
    return { action: ACTIONS.ASK_FOR_INFO, reason: 'No transaction reference found in the message' };
  }
  if (!transaction) {
    return { action: ACTIONS.ASK_FOR_INFO, reason: `Transaction ${intent.txnId} not found; ask merchant to verify the reference` };
  }
  if (transaction.status === 'REFUNDED') {
    return { action: ACTIONS.EXPLAIN_STATUS, reason: 'Transaction has already been refunded; no further money movement' };
  }
  if (intent.wantsRefund) {
    if (transaction.status !== 'SUCCESS') {
      return { action: ACTIONS.ESCALATE_TO_HUMAN, reason: 'Refund requested on a non-successful transaction' };
    }
    return { action: ACTIONS.REQUEST_REFUND_APPROVAL, reason: 'Refund requested; financial action needs approval' };
  }
  if (settlement?.status === 'ON_HOLD') {
    return { action: ACTIONS.ESCALATE_TO_HUMAN, reason: 'Settlement is on risk hold' };
  }
  if (transaction.status === 'FAILED') {
    return { action: ACTIONS.OPEN_INVESTIGATION_TICKET, reason: 'Transaction failed; open investigation for the merchant/customer claim' };
  }
  if (transaction.status === 'SUCCESS' && !transaction.settlementId) {
    return { action: ACTIONS.OPEN_INVESTIGATION_TICKET, reason: 'Successful transaction is not linked to any settlement' };
  }
  if (transaction.status === 'SUCCESS' && settlement) {
    return { action: ACTIONS.EXPLAIN_STATUS, reason: `Settlement ${settlement.id} is ${settlement.status}; explain status to merchant` };
  }
  return { action: ACTIONS.ESCALATE_TO_HUMAN, reason: 'Evidence does not match a known pattern' };
}
