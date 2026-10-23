# MerchantPulse AI

**The Autonomous Merchant Operations Teammate** — from payment problems to verified resolutions.

Paytm Hackathon · Track 3 (Autonomous AI Teammates)

**Check out**: https://merchantpulse.onrender.com

> **Prototype scope:** synthetic payment records and mock APIs only. It is not integrated with Paytm production systems.

## What it does

A merchant describes a payment problem in chat. MerchantPulse:

1. **Understands** the message (transaction ID, merchant ID, amount, intent).
2. **Investigates** with read-only tools: merchant, transaction, settlement and existing tickets.
3. **Plans** one action. A local LLM (Ollama) can propose it, but the output is validated against an allowlist. A deterministic rule planner is the default and the fallback.
4. **Checks policy.** Financial actions always need human approval. Suspended merchants and held settlements never get autonomous writes.
5. **Acts** idempotently. Ticket creation retries on transient failures and never creates duplicates.
6. **Verifies** by re-reading the ticket or refund from the backend. It only reports success after verification. Anything unverified is escalated.

Every step is written to an audit trail and shown in the dashboard timeline.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # 21 unit + HTTP tests
npm run eval         # scenario accuracy vs. a naive baseline -> data/eval-report.json
```

## Demo script 

1. **Intake:** "Customer paid ₹2,500 for TXN1001 but it is missing. M001" → case created, merchant and transaction identified.
2. **Investigation:** timeline shows read calls, and the settlement lookup finds no link.
3. **Failure recovery:** click **Demo controls → Inject 1 ticket failure**, then rerun the case. The first attempt fails, the agent retries safely, and the ticket is verified.
4. **Duplicate prevention:** send the same case again. The existing ticket is reused.
5. **Human-in-the-loop:** "Please refund TXN1002" → waits for approval. Approve it and the agent re-reads the transaction to confirm `REFUNDED`.
6. **Escalation:** "TXN1004 money not received" → risk-held settlement, escalated with evidence.

## Scenario outcomes

| Message type | Outcome |
|---|---|
| Successful but unlinked to a settlement | `TICKET_OPENED` (verified) |
| Settled and paid out | `EXPLAINED` |
| Settlement on risk hold | `ESCALATED` |
| Suspended merchant | `ESCALATED` (policy override) |
| Refund request | `APPROVAL_REQUIRED` → `REFUNDED` / `REFUND_REJECTED` |
| No transaction reference | `NEEDS_INFO` |
| Ticket system still failing after retries | `UNVERIFIED` → escalated, never claimed as success |

## API

| Method | Path | Description |
|---|---|---|
| POST | `/api/cases` | `{ "message": "..." }` → runs the full investigation |
| GET | `/api/cases` / `/api/cases/:id` | List or read cases, including audit trails |
| POST | `/api/cases/:id/decision` | `{ "approve": true \| false }` for pending refunds |
| GET | `/api/data` | Synthetic merchants, transactions, settlements, tickets |
| GET | `/api/metrics` | Verified rate, escalation rate, duplicates prevented, recoveries |
| POST | `/api/demo/inject-failure` | `{ "op": "createTicket", "times": 1 }` |
| POST | `/api/demo/reset` | Restore seed data and clear cases |

```

## Deviations from the draft's stack

The draft proposed Next.js/TypeScript, PostgreSQL/Supabase and Ollama. This build uses:

- **Express + vanilla JS dashboard** instead of Next.js/React/TypeScript. It has no build step and runs anywhere Node 20+ runs.
- **In-memory store with JSON persistence** instead of PostgreSQL. Swap in Postgres behind `CaseStore` when needed.
- **Ollama is optional.** The rule planner is the default, which keeps demos and evaluations deterministic. Enable Ollama with `LLM_PROVIDER=ollama`.

These are easy to change. The agent, policy and verification logic does not depend on the UI or the storage layer.

## Honest limits

- Evaluation numbers come from 10 hand-labelled synthetic scenarios. They show the design works on this test set, not production accuracy.
- The KPIs in the pitch (resolution time, recovery rate in production) need real operational data before they are claimed.
- Pricing and business-model numbers are illustrative.
