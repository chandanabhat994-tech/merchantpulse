import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { MockPaymentApi } from './mock/mockPaymentApi.js';
import { CaseStore } from './agent/store.js';
import { runCase, decideApproval } from './agent/caseRunner.js';
import { llmConfig } from './agent/llmPlanner.js';
import { buildSeed } from './mock/seedData.js';

/** Builds the Express app. Dependencies are injectable so tests stay hermetic. */
export function createApp({ api = new MockPaymentApi(), store = new CaseStore(), retryDelayMs = 0, llmFetch } = {}) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, llm: llmConfig().provider, prototype: 'synthetic data, mock APIs only' });
  });

  app.post('/api/cases', async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (message.length > 2000) return res.status(400).json({ error: 'message too long' });
    const c = await runCase(message, { api, store, retryDelayMs, llmFetch });
    res.status(201).json(c);
  });

  app.get('/api/cases', (_req, res) => res.json(store.list()));

  app.get('/api/cases/:id', (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'case not found' });
    res.json(c);
  });

  app.post('/api/cases/:id/decision', (req, res) => {
    try {
      const c = decideApproval(req.params.id, { api, store, approve: Boolean(req.body?.approve) });
      res.json(c);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/data', (_req, res) => {
    const s = api.seed;
    res.json({
      merchants: Object.values(s.merchants),
      transactions: Object.values(s.transactions),
      settlements: Object.values(s.settlements),
      tickets: s.tickets,
    });
  });

  app.get('/api/metrics', (_req, res) => {
    const cases = store.list();
    const byOutcome = {};
    let dedupes = 0;
    let recovered = 0;
    for (const c of cases) {
      byOutcome[c.outcome] = (byOutcome[c.outcome] || 0) + 1;
      dedupes += c.audit.filter((a) => a.type === 'dedupe').length;
      const failedThenOk = c.audit.some((a) => a.type === 'tool_call' && a.detail.tool === 'createTicket' && !a.detail.ok)
        && c.audit.some((a) => a.type === 'tool_call' && a.detail.tool === 'createTicket' && a.detail.ok);
      if (failedThenOk) recovered += 1;
    }
    const total = cases.length;
    const escalations = (byOutcome.ESCALATED || 0) + (byOutcome.UNVERIFIED || 0);
    const verifiedOk = (byOutcome.TICKET_OPENED || 0) + (byOutcome.EXPLAINED || 0) + (byOutcome.REFUNDED || 0) + (byOutcome.ESCALATED || 0);
    res.json({
      totalCases: total,
      byOutcome,
      verifiedRate: total ? verifiedOk / total : null,
      escalationRate: total ? escalations / total : null,
      duplicatesPrevented: dedupes,
      transientFailuresRecovered: recovered,
      unverifiedClaims: 0, // by design: UNVERIFIED outcomes are never reported as success
    });
  });

  app.get('/api/evaluation', async (_req, res) => {
    try {
      const p = fileURLToPath(new URL('../data/eval-report.json', import.meta.url));
      const raw = await readFile(p, 'utf-8');
      res.json(JSON.parse(raw));
    } catch {
      res.status(404).json({ error: 'Evaluation report not found. Run npm run eval to generate.' });
    }
  });

  // Demo controls (synthetic environment only)
  app.post('/api/demo/inject-failure', (req, res) => {
    const op = req.body?.op === 'createTicket' ? 'createTicket' : null;
    if (!op) return res.status(400).json({ error: 'only createTicket failures can be injected' });
    api.injectFailure(op, Math.min(Number(req.body?.times) || 1, 5));
    res.json({ ok: true, failures: api.failures });
  });

  app.post('/api/demo/reset', (_req, res) => {
    api.reset(buildSeed());
    store.clear();
    res.json({ ok: true });
  });

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'internal error' });
  });

  return { app, api, store };
}
