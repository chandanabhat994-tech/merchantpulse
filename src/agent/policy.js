/**
 * Deterministic policy engine. The LLM may propose an action, but only this
 * module decides whether it may run. Anything consequential needs a human.
 */
export const ACTIONS = {
  EXPLAIN_STATUS: 'EXPLAIN_STATUS',                 // read-only, no change
  OPEN_INVESTIGATION_TICKET: 'OPEN_INVESTIGATION_TICKET',
  ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN',
  REQUEST_REFUND_APPROVAL: 'REQUEST_REFUND_APPROVAL', // financial: needs approval
  ASK_FOR_INFO: 'ASK_FOR_INFO',
};

export const DECISIONS = { ALLOW: 'ALLOW', REQUIRE_APPROVAL: 'REQUIRE_APPROVAL', DENY: 'DENY' };

const AUTONOMOUS_WRITES = new Set([ACTIONS.OPEN_INVESTIGATION_TICKET]);
const FINANCIAL = new Set([ACTIONS.REQUEST_REFUND_APPROVAL]);

export function evaluatePolicy(action, evidence) {
  const { merchant, transaction, settlement } = evidence;

  if (action === ACTIONS.ASK_FOR_INFO || action === ACTIONS.EXPLAIN_STATUS || action === ACTIONS.ESCALATE_TO_HUMAN) {
    return { decision: DECISIONS.ALLOW, reason: 'Read-only or handoff action' };
  }
  if (FINANCIAL.has(action)) {
    return { decision: DECISIONS.REQUIRE_APPROVAL, reason: 'Financial actions always require human approval' };
  }
  if (AUTONOMOUS_WRITES.has(action)) {
    if (!merchant) return { decision: DECISIONS.DENY, reason: 'Merchant could not be verified' };
    if (merchant.status !== 'ACTIVE') {
      return { decision: DECISIONS.DENY, reason: `Merchant status is ${merchant.status}; autonomous writes disabled` };
    }
    if (settlement?.status === 'ON_HOLD') {
      return { decision: DECISIONS.DENY, reason: 'Settlement on risk hold; route to a human' };
    }
    if (!transaction) return { decision: DECISIONS.DENY, reason: 'No transaction to attach the ticket to' };
    return { decision: DECISIONS.ALLOW, reason: 'Active merchant, non-financial ticket' };
  }
  return { decision: DECISIONS.DENY, reason: `Unknown action ${action}` };
}
