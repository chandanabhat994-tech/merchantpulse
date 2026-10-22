import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MockPaymentApi } from '../src/mock/mockPaymentApi.js';
import { CaseStore } from '../src/agent/store.js';
import { runCase, decideApproval, OUTCOMES } from '../src/agent/caseRunner.js';
import { evaluatePolicy, ACTIONS, DECISIONS } from '../src/agent/policy.js';
import { llmPlan } from '../src/agent/llmPlanner.js';
import { understand } from '../src/agent/understand.js';

const fresh = () => ({ api: new MockPaymentApi(), store: new CaseStore() });
const ticketsFor = (api, txnId) => api.seed.tickets.filter((t) => t.txnId === txnId);

describe('understand', () => {
  test('extracts transaction, merchant, amount and intent', () => {
    const i = understand('Paid ₹2,500 for TXN1001 but missing. M001 urgent');
    assert.equal(i.txnId, 'TXN1001');
    assert.equal(i.merchantId, 'M001');
    assert.equal(i.amount, 2500);
    assert.equal(i.urgent, true);
    assert.equal(i.wantsRefund, false);
  });
  test('detects refund requests', () => {
    assert.equal(understand('please refund TXN1002').wantsRefund, true);
  });
});

describe('policy engine', () => {
  test('financial actions always require approval', () => {
    assert.equal(evaluatePolicy(ACTIONS.REQUEST_REFUND_APPROVAL, {}).decision, DECISIONS.REQUIRE_APPROVAL);
  });
  test('ticket creation denied for suspended merchants', () => {
    const r = evaluatePolicy(ACTIONS.OPEN_INVESTIGATION_TICKET, {
      merchant: { status: 'SUSPENDED' }, transaction: { id: 'x' }, settlement: null,
    });
    assert.equal(r.decision, DECISIONS.DENY);
  });
  test('ticket creation denied when settlement is on hold', () => {
    const r = evaluatePolicy(ACTIONS.OPEN_INVESTIGATION_TICKET, {
      merchant: { status: 'ACTIVE' }, transaction: { id: 'x' }, settlement: { status: 'ON_HOLD' },
    });
    assert.equal(r.decision, DECISIONS.DENY);
  });
});

describe('case outcomes', () => {
  test('paid but missing: opens a verified investigation ticket', async () => {
    const { api, store } = fresh();
    const c = await runCase('Customer paid ₹2,500 for TXN1001 but it is missing. M001', { api, store });
    assert.equal(c.outcome, OUTCOMES.TICKET_OPENED);
    assert.equal(ticketsFor(api, 'TXN1001').length, 1);
    assert.ok(c.audit.some((a) => a.type === 'verify_ticket' && a.detail.verified === true));
    assert.match(c.reply, /TKT-\d{4}/);
  });

  test('duplicate investigation reuses the existing ticket', async () => {
    const { api, store } = fresh();
    await runCase('TXN1001 missing payment', { api, store });
    const second = await runCase('Still missing, TXN1001 again', { api, store });
    assert.equal(second.outcome, OUTCOMES.TICKET_OPENED);
    assert.equal(ticketsFor(api, 'TXN1001').length, 1, 'no duplicate ticket');
    assert.ok(second.audit.some((a) => a.type === 'dedupe'));
  });

  test('transient ticket failures are retried and still produce exactly one ticket', async () => {
    const { api, store } = fresh();
    api.injectFailure('createTicket', 2);
    const c = await runCase('TXN1001 missing', { api, store });
    assert.equal(c.outcome, OUTCOMES.TICKET_OPENED);
    assert.equal(ticketsFor(api, 'TXN1001').length, 1);
    const attempts = c.audit.filter((a) => a.type === 'tool_call' && a.detail.tool === 'createTicket');
    assert.equal(attempts.length, 3);
    assert.equal(attempts.filter((a) => a.detail.ok).length, 1);
  });

  test('persistent failure is never reported as success', async () => {
    const { api, store } = fresh();
    api.injectFailure('createTicket', 10);
    const c = await runCase('TXN1001 missing', { api, store, retryDelayMs: 0 });
    assert.equal(c.outcome, OUTCOMES.UNVERIFIED);
    assert.match(c.reply, /escalated/i);
    assert.doesNotMatch(c.reply, /opened investigation ticket/i);
    assert.equal(ticketsFor(api, 'TXN1001').length, 0);
  });

  test('settled transaction is explained, not ticketed', async () => {
    const { api, store } = fresh();
    const c = await runCase('Status of TXN1006 please', { api, store });
    assert.equal(c.outcome, OUTCOMES.EXPLAINED);
    assert.equal(api.seed.tickets.length, 0);
  });

  test('settlement on hold escalates to a human', async () => {
    const { api, store } = fresh();
    const c = await runCase('TXN1004 money not received, urgent', { api, store });
    assert.equal(c.outcome, OUTCOMES.ESCALATED);
    assert.equal(ticketsFor(api, 'TXN1004')[0].type, 'ESCALATION');
  });

  test('suspended merchant: policy overrides ticket creation, escalates instead', async () => {
    const { api, store } = fresh();
    const c = await runCase('TXN1005 missing payment, M003', { api, store });
    assert.equal(c.outcome, OUTCOMES.ESCALATED);
    assert.ok(c.audit.some((a) => a.type === 'policy_override'));
    assert.equal(ticketsFor(api, 'TXN1005').filter((t) => t.type === 'INVESTIGATION').length, 0);
  });

  test('missing reference asks for information and writes nothing', async () => {
    const { api, store } = fresh();
    const c = await runCase('Money missing, please help', { api, store });
    assert.equal(c.outcome, OUTCOMES.NEEDS_INFO);
    assert.equal(api.seed.tickets.length, 0);
    assert.equal(api.callLog.filter((x) => x.op === 'createTicket').length, 0);
  });

  test('refund waits for approval and moves no money until approved', async () => {
    const { api, store } = fresh();
    const c = await runCase('Please refund TXN1002', { api, store });
    assert.equal(c.outcome, OUTCOMES.APPROVAL_REQUIRED);
    assert.equal(api.seed.transactions.TXN1002.status, 'SUCCESS');

    const done = decideApproval(c.id, { api, store, approve: true });
    assert.equal(done.outcome, OUTCOMES.REFUNDED);
    assert.equal(api.seed.transactions.TXN1002.status, 'REFUNDED');
  });

  test('rejected refund leaves money untouched', async () => {
    const { api, store } = fresh();
    const c = await runCase('Please refund TXN1002', { api, store });
    const done = decideApproval(c.id, { api, store, approve: false });
    assert.equal(done.outcome, OUTCOMES.REFUND_REJECTED);
    assert.equal(api.seed.transactions.TXN1002.status, 'SUCCESS');
  });

  test('refund on an already-refunded transaction is explained, not re-approved', async () => {
    const { api, store } = fresh();
    api.seed.transactions.TXN1002.status = 'REFUNDED';
    const c = await runCase('Please refund TXN1002', { api, store });
    assert.equal(c.outcome, OUTCOMES.EXPLAINED);
    assert.match(c.reply, /already been refunded/);
    assert.equal(c.pendingApproval, null);
  });

  test('cannot approve a case that is not awaiting approval', async () => {
    const { api, store } = fresh();
    const c = await runCase('TXN1006 status', { api, store });
    assert.throws(() => decideApproval(c.id, { api, store, approve: true }), /not awaiting approval/);
  });
});

describe('LLM planner guardrails', () => {
  const evidence = { intent: {}, transaction: null };
  const fakeFetch = (payload) => async () => ({ ok: true, json: async () => ({ response: payload }) });

  test('returns null when provider is rules (default)', async () => {
    assert.equal(await llmPlan(evidence, fakeFetch('{}')), null);
  });

  test('rejects actions outside the allowlist', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    try {
      assert.equal(await llmPlan(evidence, fakeFetch('{"action":"WIRE_MONEY","reason":"x"}')), null);
    } finally { delete process.env.LLM_PROVIDER; }
  });

  test('accepts a valid allowlisted action and labels it', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    try {
      const r = await llmPlan(evidence, fakeFetch('{"action":"EXPLAIN_STATUS","reason":"settled"}'));
      assert.equal(r.action, ACTIONS.EXPLAIN_STATUS);
      assert.match(r.reason, /^\[LLM\]/);
    } finally { delete process.env.LLM_PROVIDER; }
  });

  test('falls back (null) when the model is unreachable or returns junk', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    try {
      assert.equal(await llmPlan(evidence, async () => { throw new Error('ECONNREFUSED'); }), null);
      assert.equal(await llmPlan(evidence, fakeFetch('not json')), null);
    } finally { delete process.env.LLM_PROVIDER; }
  });
});
