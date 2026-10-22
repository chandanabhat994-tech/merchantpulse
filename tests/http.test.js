import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('HTTP API: investigate, read back, approve refund, metrics', async () => {
  const { app } = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const bad = await post('/api/cases', { message: '' });
    assert.equal(bad.status, 400);

    const created = await (await post('/api/cases', { message: 'Refund TXN1002' })).json();
    assert.equal(created.outcome, 'APPROVAL_REQUIRED');

    const read = await (await fetch(`${base}/api/cases/${created.id}`)).json();
    assert.equal(read.id, created.id);

    const decided = await (await post(`/api/cases/${created.id}/decision`, { approve: true })).json();
    assert.equal(decided.outcome, 'REFUNDED');

    const again = await post(`/api/cases/${created.id}/decision`, { approve: true });
    assert.equal(again.status, 409);

    const metrics = await (await fetch(`${base}/api/metrics`)).json();
    assert.equal(metrics.totalCases, 1);
    assert.equal(metrics.unverifiedClaims, 0);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
  } finally {
    server.close();
  }
});
