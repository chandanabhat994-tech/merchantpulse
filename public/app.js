/**
 * MerchantPulse AI — Autonomous Merchant Operations Dashboard
 * Frontend Controller & Interactive Studio
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'));
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');

// Outcome definitions & styling metadata
const OUTCOME = {
  TICKET_OPENED:     { headline: 'Investigation ticket opened & verified', tone: 'ok',      label: 'Ticket opened', icon: '🎫' },
  EXPLAINED:         { headline: 'Status confirmed. No change needed.',     tone: 'ok',      label: 'Explained',     icon: '✅' },
  ESCALATED:         { headline: 'Escalated to a human with the evidence',  tone: 'wait',    label: 'Escalated',     icon: '⚠️' },
  APPROVAL_REQUIRED: { headline: 'Refund is waiting for human approval',    tone: 'wait',    label: 'Needs approval', icon: '⏳' },
  REFUNDED:          { headline: 'Refund approved and backend-verified',    tone: 'ok',      label: 'Refunded',      icon: '💳' },
  REFUND_REJECTED:   { headline: 'Refund rejected. No money moved.',        tone: 'neutral', label: 'Rejected',      icon: '🛑' },
  NEEDS_INFO:        { headline: 'Needs a transaction ID to continue',      tone: 'neutral', label: 'Needs info',    icon: 'ℹ️' },
  UNVERIFIED:        { headline: 'Not verified. Escalated, not resolved.',  tone: 'fail',    label: 'Unverified',    icon: '❌' },
};
const outcomeOf = (k) => OUTCOME[k] || { headline: k, tone: 'neutral', label: k, icon: '•' };

// Application State
let activeCase = null;
let soundEnabled = localStorage.getItem('mp_sound') !== 'false';
let cachedDbData = null;
let currentDbTab = 'transactions';
let activeCaseTab = 'resolution';

// Audio Feedback (Synthesized via Web Audio API)
let audioCtx = null;
function playChime(type = 'success') {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'attention') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(554.37, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch {
    // Audio context unavailable or blocked by browser policy
  }
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${esc(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

// API Client
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Derive Pipeline Stages
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
    { key: 'understand', name: '1. Understand', state: 'done',
      detail: txn ? `Found ${txn}` : 'No transaction ID' },
    { key: 'investigate', name: '2. Investigate', state: failedReads ? 'warn' : 'done',
      detail: `${reads} read${reads === 1 ? '' : 's'}${failedReads ? `, ${failedReads} failed` : ''}` },
    { key: 'plan', name: '3. Plan', state: 'done',
      detail: c.plan?.action ? c.plan.action.replace(/_/g, ' ').toLowerCase() : '—' },
    { key: 'policy', name: '4. Policy Gate', state: 'done', detail: policy.reason || '—' },
    { key: 'act', name: '5. Act', state: 'done', detail: '' },
    { key: 'verify', name: '6. Verify', state: 'done', detail: '' },
  ];
  const [, , , pol, act, ver] = stages;

  if (policy.decision === 'REQUIRE_APPROVAL') {
    pol.state = 'wait';
    pol.detail = 'Financial action needs reviewer approval';
  } else if (policy.decision === 'DENY' || overridden) {
    pol.state = 'warn';
    pol.detail = 'Overridden to escalation: ' + (policy.reason || '');
  } else {
    pol.state = 'done';
    pol.detail = 'Allowed: ' + (policy.reason || '');
  }

  const retryNote = retries ? ` (after ${retries} retry)` : '';
  switch (o) {
    case 'TICKET_OPENED':
      act.state = 'done'; act.detail = `Ticket ${c.ticket?.id ?? ''} created${retryNote}`;
      ver.state = 'done'; ver.detail = 'Re-read backend & verified';
      break;
    case 'ESCALATED':
      act.state = 'done'; act.detail = `Escalation ${c.ticket?.id ?? ''} created${retryNote}`;
      ver.state = 'done'; ver.detail = 'Re-read backend & verified';
      break;
    case 'EXPLAINED':
      act.state = 'skip'; act.detail = 'No change needed';
      ver.state = 'done'; ver.detail = 'Status confirmed from records';
      break;
    case 'APPROVAL_REQUIRED':
      act.state = 'wait'; act.detail = 'Paused: awaiting human approval';
      ver.state = 'idle'; ver.detail = 'Runs after human confirmation';
      break;
    case 'REFUNDED':
      act.state = 'done'; act.detail = 'Refund executed after approval';
      ver.state = 'done'; ver.detail = 'Status re-read: REFUNDED';
      break;
    case 'REFUND_REJECTED':
      act.state = 'skip'; act.detail = 'Rejected by human reviewer';
      ver.state = 'skip'; ver.detail = 'No write performed';
      break;
    case 'NEEDS_INFO':
      act.state = 'skip'; act.detail = 'Waiting for transaction reference';
      ver.state = 'skip'; ver.detail = 'Nothing to verify';
      break;
    case 'UNVERIFIED':
      act.state = 'fail'; act.detail = `Backend call failed${retryNote}`;
      ver.state = 'fail'; ver.detail = 'Never reported as resolved';
      break;
    default:
      break;
  }

  let stopped = false;
  for (const s of stages) {
    if (stopped && (s.state === 'done' || s.state === 'skip')) s.state = 'idle';
    if (s.state === 'wait' || s.state === 'fail') stopped = true;
  }
  return stages;
}

const STATE_ICONS = {
  done: '✓',
  warn: '!',
  wait: '⏳',
  skip: '—',
  fail: '✕',
  idle: '○',
};

function renderRail(stages) {
  return `
    <div class="rail-container">
      <div class="rail-label-row">
        <span class="rail-section-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
          Autonomous Pipeline Execution
        </span>
        <div class="rail-legend">
          <span class="legend-item"><span class="legend-dot ok"></span> Verified</span>
          <span class="legend-item"><span class="legend-dot wait"></span> Review / Warning</span>
          <span class="legend-item"><span class="legend-dot idle"></span> Skipped / Idle</span>
        </div>
      </div>
      <ol class="rail-track" aria-label="Investigation stages">
        ${stages.map((s) => `
          <li class="stage-step" data-state="${s.state}">
            <div class="step-node" title="${esc(s.name)}: ${esc(s.detail)}">${STATE_ICONS[s.state] || '•'}</div>
            <div class="step-title">${esc(s.name)}</div>
            <div class="step-state-tag">${esc(s.state.toUpperCase())}</div>
            <div class="step-detail-txt">${esc(s.detail)}</div>
          </li>
        `).join('')}
      </ol>
    </div>
  `;
}

// Render Investigation Case View
function renderCase(c) {
  activeCase = c;
  const o = outcomeOf(c.outcome);
  const ev = c.evidence || {};
  const t = ev.transaction;
  const s = ev.settlement;
  const m = ev.merchant;

  // Format Date/Time
  const createdDate = c.createdAt ? new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Just now';

  // Build Audit Items
  const trailHtml = (c.audit || []).map((a) => {
    const isFail = a.type === 'tool_call' && a.detail.ok === false;
    let badge = 'INFO';
    let text = '';

    if (a.type === 'tool_call') {
      badge = 'TOOL';
      text = `Invoked <code>${esc(a.detail.tool)}</code> ${a.detail.ok ? '➜ Success' : `➜ <strong>FAILED</strong>: ${esc(a.detail.error)}`}`;
    } else if (a.type === 'understand') {
      badge = 'INTENT';
      text = `Extracted entities: Txn <code>${esc(a.detail.txnId || 'none')}</code>, Merchant <code>${esc(a.detail.merchantId || 'none')}</code>, Intent <code>${esc(a.detail.intent)}</code>`;
    } else if (a.type === 'plan') {
      badge = 'PLAN';
      text = `Proposed action: <strong>${esc(a.detail.action)}</strong> (${esc(a.detail.reason)})`;
    } else if (a.type === 'policy') {
      badge = 'POLICY';
      text = `Policy evaluation: <strong>${esc(a.detail.decision)}</strong> — ${esc(a.detail.reason)}`;
    } else if (a.type === 'policy_override') {
      badge = 'OVERRIDE';
      text = `Safety guardrail: <strong>${esc(a.detail.denied)}</strong> overridden to ESCALATION`;
    } else if (a.type === 'dedupe') {
      badge = 'DEDUPE';
      text = `Idempotency match: Reused existing ticket <code>${esc(a.detail.reusedTicketId)}</code> (no duplicate created)`;
    } else if (a.type === 'verify_ticket' || a.type === 'verify_refund') {
      badge = 'VERIFY';
      text = `Backend re-read verification: ${a.detail.verified ? '<strong>PASSED</strong> (Confirmed in DB)' : '<strong>FAILED</strong> (Unverified claim avoided)'}`;
    } else if (a.type === 'approval_requested') {
      badge = 'APPROVAL';
      text = `Human approval requested for refund on ${esc(a.detail.txnId)}`;
    } else if (a.type === 'approval_decision') {
      badge = 'DECISION';
      text = `Human reviewer decided: <strong>${a.detail.approved ? 'APPROVED' : 'REJECTED'}</strong>`;
    } else if (a.type === 'outcome') {
      badge = 'OUTCOME';
      text = `Final case outcome set to <strong>${esc(outcomeOf(a.detail.outcome).label)}</strong>`;
    } else {
      text = esc(JSON.stringify(a.detail || a.type));
    }

    return `
      <li class="audit-entry ${isFail ? 'fail' : a.type.startsWith('policy') ? 'policy' : a.type.startsWith('verify') ? 'verify' : ''}">
        <span class="audit-badge">${badge}</span>
        <div class="audit-desc">${text}</div>
      </li>
    `;
  }).join('');

  // Human-in-the-loop decision card
  const approvalHtml = c.outcome === 'APPROVAL_REQUIRED' ? `
    <div class="decision-banner" role="alert">
      <div class="decision-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 2 22 22 22"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="decision-body">
        <h4 class="decision-title">Human-in-the-Loop Financial Authorization Required</h4>
        <p class="decision-desc">
          Paytm Security Policy Rule #4: <strong>Autonomous fund movement is strictly prohibited</strong>.
          Executing a refund for <strong>${money(t?.amount)}</strong> on transaction <strong>${esc(t?.id)}</strong> requires human reviewer confirmation.
        </p>
        <div class="decision-actions">
          <button class="btn-approve" type="button" data-decide="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Approve &amp; Verify Refund</span>
          </button>
          <button class="btn-reject" type="button" data-decide="false">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span>Reject Request</span>
          </button>
        </div>
      </div>
    </div>
  ` : '';

  // Settlement detail string
  const settlementText = s
    ? `${esc(s.id)} · Status: <strong>${esc(s.status)}</strong>${s.holdReason ? ` (Hold: ${esc(s.holdReason)})` : ''}`
    : 'Not linked to any settlement';

  // Full Case Studio HTML
  $('#case-view').innerHTML = `
    <!-- Top Metadata Header -->
    <div class="case-top-meta">
      <div class="meta-badges">
        <div class="cid-badge">
          <span>${esc(c.id)}</span>
          <button type="button" class="btn-copy-id" id="copy-case-id-btn" title="Copy Case ID">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
        <span class="badge-tag ${o.tone}">${o.icon} ${esc(o.label)}</span>
        ${c.evidence?.transaction ? `<span class="badge-tag info">${esc(c.evidence.transaction.id)} · ${money(c.evidence.transaction.amount)}</span>` : ''}
      </div>
      <div class="time-stamp">Recorded ${createdDate}</div>
    </div>

    <!-- Outcome Headline -->
    <div class="headline-wrap">
      <h3 class="headline-title ${o.tone}">
        <span>${esc(o.headline)}</span>
      </h3>
    </div>

    <!-- Original Merchant Message Callout -->
    <div class="quote-box">
      “${esc(c.message)}”
    </div>

    <!-- 6-Stage Autonomous Pipeline Rail -->
    ${renderRail(stagesFor(c))}

    <!-- Human-in-the-Loop Banner (if required) -->
    ${approvalHtml}

    <!-- Tabs Navigation -->
    <div class="case-tabs">
      <button type="button" class="tab-btn ${activeCaseTab === 'resolution' ? 'active' : ''}" data-tab="resolution">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Merchant Resolution</span>
      </button>
      <button type="button" class="tab-btn ${activeCaseTab === 'evidence' ? 'active' : ''}" data-tab="evidence">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        <span>Evidence Ledger</span>
      </button>
      <button type="button" class="tab-btn ${activeCaseTab === 'audit' ? 'active' : ''}" data-tab="audit">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>Audit Trail (${(c.audit || []).length})</span>
      </button>
      <button type="button" class="tab-btn ${activeCaseTab === 'safety' ? 'active' : ''}" data-tab="safety">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <span>Policy &amp; Safety</span>
      </button>
    </div>

    <!-- Tab 1: Resolution Pane -->
    <div class="tab-pane ${activeCaseTab === 'resolution' ? 'active' : ''}" id="pane-resolution">
      <div class="resolution-content">
        <div class="resolution-header">
          <div class="resolution-agent-info">
            <span class="status-indicator"></span>
            <span>Verified AI Teammate Response</span>
          </div>
          <span class="badge-subtle">Ready to send</span>
        </div>
        <p class="reply-text">${esc(c.reply)}</p>
        <div class="resolution-actions">
          <button type="button" class="btn-secondary" id="copy-reply-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>Copy Message</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Tab 2: Evidence Ledger Pane -->
    <div class="tab-pane ${activeCaseTab === 'evidence' ? 'active' : ''}" id="pane-evidence">
      <div class="evidence-grid">
        <!-- Merchant Card -->
        <div class="evidence-card">
          <div class="evidence-header">
            <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Merchant Account</h4>
            ${m ? `<span class="badge-tag ${m.status === 'ACTIVE' ? 'ok' : 'fail'}">${esc(m.status)}</span>` : ''}
          </div>
          <dl class="evidence-dl">
            <dt>ID</dt><dd class="mono">${m ? esc(m.id) : '—'}</dd>
            <dt>Business</dt><dd>${m ? esc(m.name) : '—'}</dd>
            <dt>Location</dt><dd>${m ? esc(m.city) : '—'}</dd>
            <dt>KYC</dt><dd>${m?.kycVerified ? '<span style="color:var(--color-ok)">Verified ✓</span>' : 'Unverified'}</dd>
          </dl>
        </div>

        <!-- Transaction Card -->
        <div class="evidence-card">
          <div class="evidence-header">
            <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> Transaction</h4>
            ${t ? `<span class="badge-tag ${t.status === 'SUCCESS' ? 'ok' : t.status === 'FAILED' ? 'fail' : 'wait'}">${esc(t.status)}</span>` : ''}
          </div>
          <dl class="evidence-dl">
            <dt>Reference</dt><dd class="mono">${t ? esc(t.id) : '—'}</dd>
            <dt>Amount</dt><dd class="amount-lg">${t ? money(t.amount) : '—'}</dd>
            <dt>Gateway</dt><dd>${t ? esc(t.status) : '—'}</dd>
            <dt>Timestamp</dt><dd class="mono">${t?.createdAt ? new Date(t.createdAt).toLocaleString('en-IN') : '—'}</dd>
          </dl>
        </div>

        <!-- Settlement Card -->
        <div class="evidence-card">
          <div class="evidence-header">
            <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg> Settlement</h4>
            ${s ? `<span class="badge-tag ${s.status === 'PAID' ? 'ok' : s.status === 'ON_HOLD' ? 'wait' : 'info'}">${esc(s.status)}</span>` : ''}
          </div>
          <dl class="evidence-dl">
            <dt>Batch ID</dt><dd class="mono">${s ? esc(s.id) : 'None linked'}</dd>
            <dt>Status</dt><dd>${s ? esc(s.status) : 'Unsettled'}</dd>
            <dt>Hold Flag</dt><dd>${s?.holdReason ? `<strong style="color:var(--color-wait)">${esc(s.holdReason)}</strong>` : 'None'}</dd>
            <dt>Payout Date</dt><dd class="mono">${s?.payoutDate || 'Pending'}</dd>
          </dl>
        </div>

        <!-- Ticket Card -->
        <div class="evidence-card">
          <div class="evidence-header">
            <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg> Support Ticket</h4>
            ${c.ticket ? `<span class="badge-tag ok">${esc(c.ticket.status || 'OPEN')}</span>` : ''}
          </div>
          <dl class="evidence-dl">
            <dt>Ticket ID</dt><dd class="mono">${c.ticket ? esc(c.ticket.id) : 'None created'}</dd>
            <dt>Type</dt><dd>${c.ticket ? esc(c.ticket.type) : '—'}</dd>
            <dt>Deduplication</dt><dd>${c.audit?.some((a) => a.type === 'dedupe') ? '<span style="color:var(--color-ok)">Reused existing ticket ✓</span>' : 'Fresh idempotent creation'}</dd>
            <dt>Backend State</dt><dd>${c.ticket ? 'Verified in DB' : '—'}</dd>
          </dl>
        </div>
      </div>
    </div>

    <!-- Tab 3: Audit Trail Pane -->
    <div class="tab-pane ${activeCaseTab === 'audit' ? 'active' : ''}" id="pane-audit">
      <ul class="audit-timeline">
        ${trailHtml || '<li class="audit-entry">No events recorded.</li>'}
      </ul>
    </div>

    <!-- Tab 4: Safety & Policy Pane -->
    <div class="tab-pane ${activeCaseTab === 'safety' ? 'active' : ''}" id="pane-safety">
      <div class="resolution-content">
        <h4 style="font-size:14px;font-weight:700;margin-bottom:8px;">Autonomous Guardrail Architecture</h4>
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
          MerchantPulse AI combines deterministic safety filters with autonomous investigations to eliminate false claims and unapproved financial actions.
        </p>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;font-size:12px;">
          <div style="background:var(--bg-surface);padding:10px;border-radius:6px;border:1px solid var(--border-subtle);">
            <strong style="color:var(--color-ok)">1. Read vs. Write Separation</strong>
            <p style="color:var(--text-muted);margin-top:2px;">Investigation uses strictly read-only tools across merchants, transactions, settlements and tickets.</p>
          </div>
          <div style="background:var(--bg-surface);padding:10px;border-radius:6px;border:1px solid var(--border-subtle);">
            <strong style="color:var(--color-wait)">2. Mandatory Financial Approvals</strong>
            <p style="color:var(--text-muted);margin-top:2px;">All refund and balance-altering actions require human-in-the-loop review.</p>
          </div>
          <div style="background:var(--bg-surface);padding:10px;border-radius:6px;border:1px solid var(--border-subtle);">
            <strong style="color:var(--color-info)">3. Idempotent Deduplication</strong>
            <p style="color:var(--text-muted);margin-top:2px;">Existing open tickets are reused rather than duplicated when merchants re-ask.</p>
          </div>
          <div style="background:var(--bg-surface);padding:10px;border-radius:6px;border:1px solid var(--border-subtle);">
            <strong style="color:var(--brand-primary)">4. Mandatory Backend Verification</strong>
            <p style="color:var(--text-muted);margin-top:2px;">Every ticket or refund is re-read from storage before declaring success to the user.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // Attach Approval Listeners
  document.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const approve = btn.dataset.decide === 'true';
      btn.disabled = true;
      try {
        const updated = await api(`/api/cases/${c.id}/decision`, {
          method: 'POST',
          body: { approve },
        });
        playChime(approve ? 'success' : 'attention');
        showToast(approve ? 'Refund approved and backend verified!' : 'Refund request rejected.', approve ? 'success' : 'warning');
        renderCase(updated);
        refresh();
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Attach Tab Switchers
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCaseTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${activeCaseTab}`));
    });
  });

  // Copy Case ID
  const copyIdBtn = $('#copy-case-id-btn');
  if (copyIdBtn) {
    copyIdBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(c.id);
      showToast(`Copied ${c.id} to clipboard!`);
    });
  }

  // Copy Reply
  const copyReplyBtn = $('#copy-reply-btn');
  if (copyReplyBtn) {
    copyReplyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(c.reply);
      showToast('Merchant reply copied to clipboard!');
    });
  }
}

function showCase(c) {
  renderCase(c);
  document.querySelectorAll('.case-item-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.case === c.id);
  });
}

// Refresh Cases Feed
async function refreshCases() {
  const cases = await api('/api/cases');
  const badge = $('#case-count-badge');
  if (badge) badge.textContent = cases.length;

  const list = $('#case-list');
  if (!list) return;

  if (!cases.length) {
    list.innerHTML = '<li class="card-description" style="padding:10px 0;">No cases investigated yet.</li>';
    return;
  }

  list.innerHTML = cases.slice(0, 30).map((c) => {
    const o = outcomeOf(c.outcome);
    const isActive = activeCase && activeCase.id === c.id;
    return `
      <li>
        <button type="button" class="case-item-btn ${isActive ? 'active' : ''}" data-case="${esc(c.id)}">
          <div class="case-item-info">
            <span class="case-item-id">${esc(c.id)}</span>
            <span class="case-item-msg">${esc(c.message)}</span>
          </div>
          <span class="case-pill ${o.tone}">${esc(o.label)}</span>
        </button>
      </li>
    `;
  }).join('');

  document.querySelectorAll('[data-case]').forEach((b) => {
    b.addEventListener('click', async () => {
      showCase(await api(`/api/cases/${b.dataset.case}`));
    });
  });
}

// Refresh Metrics Bar
async function refreshMetrics() {
  const m = await api('/api/metrics');
  const grid = $('#metrics');
  if (!grid) return;

  grid.innerHTML = `
    <div class="metric-card">
      <div class="metric-top">
        <span class="metric-title">Cases Investigated</span>
        <span class="metric-badge info">Autonomous</span>
      </div>
      <div class="metric-val">${m.totalCases}</div>
      <div class="metric-sub">Multi-system triage</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <span class="metric-title">Verified Resolutions</span>
        <span class="metric-badge ok">Confirmed</span>
      </div>
      <div class="metric-val" style="color:var(--color-ok)">${pct(m.verifiedRate)}</div>
      <div class="metric-sub">Re-read from DB</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <span class="metric-title">Human Escalations</span>
        <span class="metric-badge wait">Policy Gate</span>
      </div>
      <div class="metric-val" style="color:var(--color-wait)">${pct(m.escalationRate)}</div>
      <div class="metric-sub">Zero unapproved writes</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <span class="metric-title">Duplicates Prevented</span>
        <span class="metric-badge ok">Idempotent</span>
      </div>
      <div class="metric-val">${m.duplicatesPrevented}</div>
      <div class="metric-sub">Existing tickets reused</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <span class="metric-title">Self-Healing Recoveries</span>
        <span class="metric-badge info">Retried</span>
      </div>
      <div class="metric-val">${m.transientFailuresRecovered}</div>
      <div class="metric-sub">Transient 500s handled</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <span class="metric-title">Unverified Claims</span>
        <span class="metric-badge ok">0 Hallucinations</span>
      </div>
      <div class="metric-val" style="color:var(--color-ok)">${m.unverifiedClaims}</div>
      <div class="metric-sub">Never claims unproven success</div>
    </div>
  `;
}

// Render Database Explorer Tab Content
function renderDbTab(tabKey) {
  if (!cachedDbData) return;
  const container = $('#db-content');
  if (!container) return;

  const table = (cols, rows) => `
    <table class="styled-table">
      <thead>
        <tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows.map((r) => `<tr>${cols.map((c) => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
  `;

  if (tabKey === 'transactions') {
    container.innerHTML = table([
      ['ID', (r) => `<span class="clickable-id" data-fill="Check status of ${r.id}">${esc(r.id)}</span>`],
      ['Merchant', (r) => `<span class="mono">${esc(r.merchantId)}</span>`],
      ['Amount', (r) => `<span class="mono font-bold">${money(r.amount)}</span>`],
      ['Status', (r) => `<span class="badge-tag ${r.status === 'SUCCESS' ? 'ok' : r.status === 'FAILED' ? 'fail' : 'wait'}">${esc(r.status)}</span>`],
      ['Settlement', (r) => `<span class="mono">${esc(r.settlementId || 'None')}</span>`],
      ['Created At', (r) => `<span class="mono text-xs">${esc(r.createdAt || '—')}</span>`],
    ], cachedDbData.transactions);
  } else if (tabKey === 'settlements') {
    container.innerHTML = table([
      ['Batch ID', (r) => `<span class="mono">${esc(r.id)}</span>`],
      ['Merchant', (r) => `<span class="mono">${esc(r.merchantId)}</span>`],
      ['Status', (r) => `<span class="badge-tag ${r.status === 'PAID' ? 'ok' : r.status === 'ON_HOLD' ? 'wait' : 'info'}">${esc(r.status)}</span>`],
      ['Hold Reason', (r) => esc(r.holdReason || 'None')],
      ['Amount', (r) => `<span class="mono font-bold">${money(r.amount)}</span>`],
      ['Payout Date', (r) => esc(r.payoutDate || 'Pending')],
    ], cachedDbData.settlements);
  } else if (tabKey === 'merchants') {
    container.innerHTML = table([
      ['Merchant ID', (r) => `<span class="mono">${esc(r.id)}</span>`],
      ['Business Name', (r) => esc(r.name)],
      ['City', (r) => esc(r.city)],
      ['Status', (r) => `<span class="badge-tag ${r.status === 'ACTIVE' ? 'ok' : 'fail'}">${esc(r.status)}</span>`],
      ['KYC Verified', (r) => (r.kycVerified ? '<span style="color:var(--color-ok)">Yes ✓</span>' : 'No')],
    ], cachedDbData.merchants);
  } else if (tabKey === 'tickets') {
    if (!cachedDbData.tickets.length) {
      container.innerHTML = '<p class="card-description" style="padding:20px 0;text-align:center;">No support tickets created yet.</p>';
    } else {
      container.innerHTML = table([
        ['Ticket ID', (r) => `<span class="mono">${esc(r.id)}</span>`],
        ['Transaction', (r) => `<span class="mono">${esc(r.txnId)}</span>`],
        ['Type', (r) => esc(r.type)],
        ['Status', (r) => `<span class="badge-tag ok">${esc(r.status)}</span>`],
      ], cachedDbData.tickets);
    }
  }

  // Clickable IDs fill the inquiry prompt
  container.querySelectorAll('[data-fill]').forEach((el) => {
    el.addEventListener('click', () => {
      $('#message').value = el.dataset.fill;
      $('#db-modal').close();
      $('#message').focus();
      showToast(`Inserted ${el.textContent} into investigation prompt`);
    });
  });
}

// Load Evaluation Benchmark
async function loadBenchmark() {
  const container = $('#eval-content');
  if (!container) return;
  try {
    const report = await api('/api/evaluation');
    const mp = report.merchantPulse;
    const base = report.baseline;

    container.innerHTML = `
      <div class="benchmark-kpis">
        <div class="benchmark-card winner">
          <div>
            <div class="bench-title">MerchantPulse AI</div>
            <div class="bench-desc">Autonomous Teammate with Guardrails</div>
          </div>
          <div class="bench-stat ok">${mp.resolutionAccuracyPct}% <div class="bench-stat sub">${mp.unsafeActions} unsafe actions</div></div>
        </div>
        <div class="benchmark-card">
          <div>
            <div class="bench-title">Naive Baseline Bot</div>
            <div class="bench-desc">Unregulated Ticket Creation</div>
          </div>
          <div class="bench-stat">${base.resolutionAccuracyPct}% <div class="bench-stat sub" style="color:var(--color-fail)">${base.unsafeActions} unsafe action</div></div>
        </div>
      </div>

      <table class="styled-table">
        <thead>
          <tr>
            <th>Scenario ID</th>
            <th>Problem Inquiry</th>
            <th>Expected</th>
            <th>MerchantPulse</th>
            <th>Baseline</th>
          </tr>
        </thead>
        <tbody>
          ${report.rows.map((r) => `
            <tr>
              <td class="mono font-bold">${esc(r.id)}</td>
              <td>${esc(r.message)}</td>
              <td><span class="badge-tag info">${esc(r.expected)}</span></td>
              <td>
                <span class="badge-tag ${r.mp.correct ? 'ok' : 'fail'}">${r.mp.correct ? '✓' : '✕'} ${esc(r.mp.outcome)}</span>
                ${r.mp.unsafe ? '<span class="badge-tag fail">⚠ Unsafe</span>' : ''}
              </td>
              <td>
                <span class="badge-tag ${r.baseline.correct ? 'ok' : 'fail'}">${r.baseline.correct ? '✓' : '✕'} ${esc(r.baseline.outcome)}</span>
                ${r.baseline.unsafe ? '<span class="badge-tag fail">⚠ Unsafe</span>' : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<p class="card-description" style="color:var(--color-fail)">Could not load evaluation report: ${esc(err.message)}</p>`;
  }
}

// Master Refresh
async function refresh() {
  await Promise.allSettled([
    refreshCases(),
    refreshMetrics(),
    api('/api/data').then((d) => { cachedDbData = d; }),
  ]);
}

// Event Listeners Initialization
function initEvents() {
  // Chat form submit
  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgInput = $('#message');
    const message = msgInput.value.trim();
    if (!message) return;

    const btn = $('#investigate-btn');
    btn.disabled = true;

    // Show interactive loading spinner in case container
    $('#case-view').innerHTML = `
      <div class="loading-box">
        <div class="spinner-wrap">
          <div class="spinner-ring"></div>
          <div class="spinner-ring"></div>
        </div>
        <p class="loading-text">Investigating Payment Discrepancy…</p>
        <p class="loading-subtext">Multi-system read ➜ Policy check ➜ Idempotent execution ➜ Backend verification</p>
      </div>
    `;

    try {
      const c = await api('/api/cases', { method: 'POST', body: { message } });
      playChime(c.outcome === 'APPROVAL_REQUIRED' ? 'attention' : 'success');
      showCase(c);
      msgInput.value = '';
      $('#char-count').textContent = '0/2000';
      refresh();
      showToast('Investigation complete & verified!', 'success');
    } catch (err) {
      $('#case-view').innerHTML = `
        <div class="resolution-content" style="border-color:var(--color-fail-border);background:var(--color-fail-bg);">
          <h4 style="color:var(--color-fail);font-weight:700;">Investigation Error</h4>
          <p style="color:var(--text-main);margin-top:4px;">${esc(err.message)}</p>
        </div>
      `;
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Textarea character count and Cmd/Ctrl+Enter submission
  const msgArea = $('#message');
  msgArea.addEventListener('input', () => {
    $('#char-count').textContent = `${msgArea.value.length}/2000`;
  });
  msgArea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });

  // Sample prompt buttons
  $$('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', () => {
      msgArea.value = btn.dataset.sample;
      $('#char-count').textContent = `${msgArea.value.length}/2000`;
      msgArea.focus();
    });
  });

  // Demo Failure Injection
  $('#inject').addEventListener('click', async () => {
    try {
      await api('/api/demo/inject-failure', { method: 'POST', body: { op: 'createTicket', times: 1 } });
      $('#demo-status').textContent = 'Next ticket creation will fail once ➜ autonomous retry kicks in!';
      showToast('Transient failure injected for next ticket creation', 'warning');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Demo Reset
  $('#reset').addEventListener('click', async () => {
    if (!confirm('Reset all synthetic data and cases back to seed state?')) return;
    try {
      await api('/api/demo/reset', { method: 'POST' });
      $('#case-view').innerHTML = `
        <div class="empty-state">
          <div class="empty-art">
            <div class="empty-pulse-circle">
              <img src="logo.jpg" alt="MerchantPulse Logo" width="64" height="64" class="pulse-logo">
            </div>
          </div>
          <h2 class="empty-title">Demo State Reset</h2>
          <p class="empty-subtitle">All synthetic merchants, transactions, settlements and ticket records have been restored.</p>
        </div>
      `;
      $('#demo-status').textContent = '';
      activeCase = null;
      refresh();
      showToast('Environment successfully reset to seed state.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Demo accordion toggle
  const demoToggle = $('#demo-toggle-trigger');
  const demoContent = $('#demo-controls-content');
  if (demoToggle && demoContent) {
    demoToggle.addEventListener('click', () => {
      demoToggle.classList.toggle('collapsed');
      demoContent.classList.toggle('collapsed');
    });
  }

  // Benchmark Modal Open/Close
  const evalModal = $('#eval-modal');
  $('#open-eval-btn').addEventListener('click', () => {
    loadBenchmark();
    evalModal.showModal();
  });
  $('#close-eval-modal').addEventListener('click', () => evalModal.close());
  evalModal.addEventListener('click', (e) => {
    if (e.target === evalModal || e.target.classList.contains('modal-backdrop')) evalModal.close();
  });

  // DB Records Modal Open/Close
  const dbModal = $('#db-modal');
  $('#open-db-btn').addEventListener('click', async () => {
    if (!cachedDbData) cachedDbData = await api('/api/data');
    renderDbTab(currentDbTab);
    dbModal.showModal();
  });
  $('#close-db-modal').addEventListener('click', () => dbModal.close());
  dbModal.addEventListener('click', (e) => {
    if (e.target === dbModal || e.target.classList.contains('modal-backdrop')) dbModal.close();
  });

  // DB Tab switcher inside records modal
  $$('.db-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.db-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      currentDbTab = btn.dataset.dbtab;
      renderDbTab(currentDbTab);
    });
  });

  // Theme Toggle (Dark / Light)
  const themeBtn = $('#theme-toggle-btn');
  const savedTheme = localStorage.getItem('mp_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcons(savedTheme);

  themeBtn.addEventListener('click', () => {
    const curr = document.documentElement.getAttribute('data-theme');
    const next = curr === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('mp_theme', next);
    updateThemeIcons(next);
  });

  function updateThemeIcons(theme) {
    const sun = $('.sun-icon');
    const moon = $('.moon-icon');
    if (theme === 'dark') {
      sun.classList.remove('hidden');
      moon.classList.add('hidden');
    } else {
      sun.classList.add('hidden');
      moon.classList.remove('hidden');
    }
  }

  // Sound Toggle
  const soundBtn = $('#sound-toggle-btn');
  updateSoundIcons();
  soundBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem('mp_sound', soundEnabled);
    updateSoundIcons();
    showToast(soundEnabled ? 'Sound alerts enabled' : 'Sound alerts muted');
  });

  function updateSoundIcons() {
    const soundOn = $('.sound-on');
    const soundOff = $('.sound-off');
    if (soundEnabled) {
      soundOn.classList.remove('hidden');
      soundOff.classList.add('hidden');
    } else {
      soundOn.classList.add('hidden');
      soundOff.classList.remove('hidden');
    }
  }
}

// Initial Launch
initEvents();
refresh();
