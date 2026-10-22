const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'));
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');

// Outcome copy: short headline, tone, and the short label used in lists.
const OUTCOME = {
  TICKET_OPENED:     { headline: 'Investigation ticket opened and verified', tone: 'ok',      label: 'Ticket opened' },
  EXPLAINED:         { headline: 'Status confirmed. No action needed.',       tone: 'ok',      label: 'Explained' },
  ESCALATED:         { headline: 'Escalated to a human with the evidence',    tone: 'wait',    label: 'Escalated' },
  APPROVAL_REQUIRED: { headline: 'Refund is waiting for approval',            tone: 'wait',    label: 'Awaiting approval' },
  REFUNDED:          { headline: 'Refund approved and verified',              tone: 'ok',      label: 'Refunded' },
  REFUND_REJECTED:   { headline: 'Refund rejected. No money moved.',          tone: 'neutral', label: 'Rejected' },
  NEEDS_INFO:        { headline: 'Needs a transaction ID to continue',        tone: 'neutral', label: 'Needs info' },
  UNVERIFIED:        { headline: 'Not verified. Escalated, not resolved.',    tone: 'fail',    label: 'Unverified' },
};
const outcomeOf = (k) => OUTCOME[k] || { headline: k, tone: 'neutral', label: k };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * Derives the six pipeline stages from the case's audit trail and outcome.
 * States: done | warn | wait | skip | fail | idle (not reached because the pipeline stopped earlier).
 */
function stagesFor(c) {
  const audit = c.audit || [];
  const toolCalls = audit.filter((a) => a.type === 'tool_call');
  const reads = toolCalls.filter((a) => a.detail.tool !== 'createTicket' && a.detail.tool !== 'getTicket').length;
  const failedReads = toolCalls.filter((a) => a.detail.ok === false && a.detail.tool !== 'createTicket').length;
  const ticketAttempts = toolCalls.filter((a) => a.detail.tool === 'createTicket');
  const retries = ticketAttempts.filter((a) => a.detail.ok === false).length;
  const overridden = audit.some((a) => a.type === 'policy_override');
  const policy = c.policy || {};
  const o = c.outcome;
  const txn = c.intent?.txnId;

  const stages = [
    { key: 'understand', name: 'Understand', state: 'done',
      detail: txn ? `Found ${txn}` : 'No transaction ID' },
    { key: 'investigate', name: 'Investigate', state: failedReads ? 'warn' : 'done',
      detail: `${reads} read${reads === 1 ? '' : 's'}${failedReads ? `, ${failedReads} failed` : ''}` },
    { key: 'plan', name: 'Plan', state: 'done',
      detail: c.plan?.action ? c.plan.action.replace(/_/g, ' ').toLowerCase() : '—' },
    { key: 'policy', name: 'Policy', state: 'done', detail: policy.reason || '—' },
    { key: 'act', name: 'Act', state: 'done', detail: '' },
    { key: 'verify', name: 'Verify', state: 'done', detail: '' },
  ];
  const [, , , pol, act, ver] = stages;

  if (policy.decision === 'REQUIRE_APPROVAL') pol.state = 'wait', pol.detail = 'Financial action needs a reviewer';
  else if (policy.decision === 'DENY' || overridden) pol.state = 'warn', pol.detail = 'Overridden to escalation: ' + (policy.reason || '');
  else pol.state = 'done', pol.detail = 'Allowed: ' + (policy.reason || '');

  const retryNote = retries ? `, after ${retries} ${retries === 1 ? 'retry' : 'retries'}` : '';
  switch (o) {
    case 'TICKET_OPENED':
      act.state = 'done'; act.detail = `Ticket ${c.ticket?.id ?? ''} created${retryNote}`;
      ver.state = 'done'; ver.detail = 'Re-read from the backend';
      break;
    case 'ESCALATED':
      act.state = 'done'; act.detail = `Escalation ${c.ticket?.id ?? ''} created${retryNote}`;
      ver.state = 'done'; ver.detail = 'Re-read from the backend';
      break;
    case 'EXPLAINED':
      act.state = 'skip'; act.detail = 'No change needed';
      ver.state = 'done'; ver.detail = 'Status re-read from records';
      break;
    case 'APPROVAL_REQUIRED':
      act.state = 'wait'; act.detail = 'Paused for a reviewer';
      ver.state = 'idle'; ver.detail = 'Runs after approval';
      break;
    case 'REFUNDED':
      act.state = 'done'; act.detail = 'Refund applied after approval';
      ver.state = 'done'; ver.detail = 'Status now REFUNDED';
      break;
    case 'REFUND_REJECTED':
      act.state = 'skip'; act.detail = 'Rejected by reviewer';
      ver.state = 'skip'; ver.detail = 'Nothing to verify';
      break;
    case 'NEEDS_INFO':
      act.state = 'skip'; act.detail = 'Waiting for a reference';
      ver.state = 'skip'; ver.detail = 'Nothing to verify';
      break;
    case 'UNVERIFIED':
      act.state = 'fail'; act.detail = `Could not complete${retryNote}`;
      ver.state = 'fail'; ver.detail = 'Not confirmed; escalated';
      break;
    default:
      break;
  }

  // The rail stops at the first point the pipeline could not pass.
  // Later stages are shown as not reached, not as complete.
  let stopped = false;
  for (const s of stages) {
    if (stopped && (s.state === 'done' || s.state === 'skip')) s.state = 'idle';
    if (s.state === 'wait' || s.state === 'fail') stopped = true;
  }
  return stages;
}

const STATE_LABEL = { done: 'Done', warn: 'Done with issues', wait: 'Waiting', skip: 'Skipped', fail: 'Failed', idle: 'Not reached' };

function renderRail(stages) {
  return `<ol class="rail animate" aria-label="Investigation stages">${stages.map((s, i) => `
    <li class="stage" data-state="${s.state}" style="--i:${i}">
      <span class="stage-dot" aria-hidden="true"></span>
      <span class="stage-name">${esc(s.name)}</span>
      <span class="stage-state">${esc(STATE_LABEL[s.state])}</span>
      <span class="stage-detail">${esc(s.detail)}</span>
    </li>`).join('')}
  </ol>`;
}

function renderCase(c) {
  const o = outcomeOf(c.outcome);
  const ev = c.evidence || {};
  const t = ev.transaction, s = ev.settlement, m = ev.merchant;

  const trail = (c.audit || []).map((a) => {
    const failed = a.type === 'tool_call' && a.detail.ok === false;
    let text;
    if (a.type === 'tool_call') text = `<code>${esc(a.detail.tool)}</code> ${a.detail.ok ? 'ok' : `failed: ${esc(a.detail.error)}`}`;
    else if (a.type === 'understand') text = `Read intent: ${esc(JSON.stringify(a.detail))}`;
    else if (a.type === 'plan') text = `Plan ${esc(a.detail.action)}: ${esc(a.detail.reason)}`;
    else if (a.type === 'policy') text = `Policy ${esc(a.detail.decision)}: ${esc(a.detail.reason)}`;
    else if (a.type === 'policy_override') text = `Overridden: ${esc(a.detail.denied)} became escalation`;
    else if (a.type === 'dedupe') text = `Reused existing ticket ${esc(a.detail.reusedTicketId)} instead of creating a duplicate`;
    else if (a.type === 'verify_ticket' || a.type === 'verify_refund') text = `Verification ${a.detail.verified ? 'passed' : 'failed'}`;
    else if (a.type === 'approval_requested') text = `Refund for ${esc(a.detail.txnId)} sent for approval`;
    else if (a.type === 'approval_decision') text = `Reviewer ${a.detail.approved ? 'approved' : 'rejected'} the refund`;
    else if (a.type === 'outcome') text = `Outcome: ${esc(outcomeOf(a.detail.outcome).label)}`;
    else text = esc(a.type);
    return `<li class="${failed ? 'fail' : ''}">${text}</li>`;
  }).join('');

  const approval = c.outcome === 'APPROVAL_REQUIRED' ? `
    <div class="decision">
      <p>Only a reviewer can move money. Approving runs the refund and re-reads the transaction to confirm it.</p>
      <div class="row">
        <button class="approve" type="button" data-decide="true">Approve refund</button>
        <button class="reject" type="button" data-decide="false">Reject</button>
      </div>
    </div>` : '';

  const settlementText = s
    ? `${esc(s.id)} · ${esc(s.status.replace(/_/g, ' ').toLowerCase())}${s.holdReason ? ` (${esc(s.holdReason)})` : ''}`
    : 'Not linked to any settlement';

  $('#case-view').innerHTML = `
    <p class="case-id">${esc(c.id)}</p>
    <h3 class="headline ${o.tone}">${esc(o.headline)}</h3>
    <p class="quote">“${esc(c.message)}”</p>
    ${renderRail(stagesFor(c))}
    <p class="reply" aria-live="polite">${esc(c.reply)}</p>
    ${approval}
    <h3 class="h3">Evidence</h3>
    <dl class="ledger">
      <dt>Merchant</dt><dd>${m ? `${esc(m.name)} <span class="mono">${esc(m.id)}</span> · ${esc(m.status.toLowerCase())}` : '—'}</dd>
      <dt>Transaction</dt><dd>${t ? `<span class="mono">${esc(t.id)}</span> · <span class="amount">${money(t.amount)}</span> · ${esc(t.status.toLowerCase())}` : '—'}</dd>
      <dt>Settlement</dt><dd>${settlementText}</dd>
      <dt>Ticket</dt><dd>${c.ticket ? `<span class="mono">${esc(c.ticket.id)}</span> · ${esc(c.ticket.type.toLowerCase())} · ${esc((c.ticket.status || 'OPEN').toLowerCase())}` : 'None created'}</dd>
    </dl>
    <details class="trail">
      <summary>Audit trail (${(c.audit || []).length} events)</summary>
      <ol class="trail">${trail || '<li>No activity</li>'}</ol>
    </details>`;

  document.querySelectorAll('[data-decide]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const updated = await api(`/api/cases/${c.id}/decision`, { method: 'POST', body: { approve: btn.dataset.decide === 'true' } });
      renderCase(updated);
      refresh();
    } catch (e) { alert(e.message); }
  }));
}

function showCase(c) {
  renderCase(c);
  document.querySelectorAll('.case-list button').forEach((b) => b.setAttribute('aria-current', b.dataset.case === c.id ? 'true' : 'false'));
}

async function refreshCases() {
  const cases = await api('/api/cases');
  $('#case-list').innerHTML = cases.slice(0, 20).map((c) => {
    const o = outcomeOf(c.outcome);
    return `<li><button type="button" data-case="${esc(c.id)}">
      <span class="cid">${esc(c.id)}</span>
      <span class="cmsg">${esc(c.message)}</span>
      <span class="cout ${o.tone === 'ok' ? 'ok' : o.tone === 'fail' ? 'fail' : 'wait'}" style="color:var(--${o.tone === 'ok' ? 'ok' : o.tone === 'fail' ? 'fail' : 'wait'})">${esc(o.label)}</span>
    </button></li>`;
  }).join('') || '<li class="muted">No cases yet</li>';
  document.querySelectorAll('[data-case]').forEach((b) => b.addEventListener('click', async () => showCase(await api(`/api/cases/${b.dataset.case}`))));
}

async function refreshMetrics() {
  const m = await api('/api/metrics');
  const fig = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  $('#metrics').innerHTML = [
    fig('Cases investigated', m.totalCases),
    fig('Verified outcomes', pct(m.verifiedRate)),
    fig('Escalated', pct(m.escalationRate)),
    fig('Duplicates prevented', m.duplicatesPrevented),
    fig('Failures recovered', m.transientFailuresRecovered),
    fig('Unverified claims', m.unverifiedClaims),
  ].join('');
}

async function refreshData() {
  const d = await api('/api/data');
  const table = (cols, rows) => `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th scope="col">${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(c[1](r))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  $('#data').innerHTML =
    '<h3>Transactions</h3>' + table([['ID', (r) => r.id], ['Merchant', (r) => r.merchantId], ['Amount', (r) => money(r.amount)], ['Status', (r) => r.status], ['Settlement', (r) => r.settlementId || '—']], d.transactions) +
    '<h3>Settlements</h3>' + table([['ID', (r) => r.id], ['Merchant', (r) => r.merchantId], ['Status', (r) => r.status], ['Amount', (r) => money(r.amount)]], d.settlements) +
    '<h3>Support tickets</h3>' + (d.tickets.length ? table([['ID', (r) => r.id], ['Transaction', (r) => r.txnId], ['Type', (r) => r.type], ['Status', (r) => r.status]], d.tickets) : '<p class="muted">No tickets yet</p>');
}

function refresh() { refreshCases(); refreshMetrics(); refreshData(); }

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('#message').value.trim();
  if (!message) return;
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  $('#case-view').innerHTML = '<p class="muted" role="status">Investigating…</p>';
  try {
    const c = await api('/api/cases', { method: 'POST', body: { message } });
    showCase(c);
    $('#message').value = '';
    refresh();
  } catch (err) {
    $('#case-view').innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
  } finally { btn.disabled = false; }
});

document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => {
  $('#message').value = b.dataset.sample;
  $('#message').focus();
}));

$('#inject').addEventListener('click', async () => {
  const r = await api('/api/demo/inject-failure', { method: 'POST', body: { op: 'createTicket', times: 1 } });
  $('#demo-status').textContent = `The next ticket creation will fail once, then the agent retries.`;
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Reset all synthetic data and cases?')) return;
  await api('/api/demo/reset', { method: 'POST' });
  $('#case-view').innerHTML = '<div class="empty"><p class="empty-title">Demo data reset.</p><p class="muted">Describe a payment problem to start again.</p></div>';
  $('#demo-status').textContent = '';
  refresh();
});

refresh();
