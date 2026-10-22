import { ACTIONS } from './policy.js';

/**
 * Optional Ollama-backed planner. Enabled with LLM_PROVIDER=ollama.
 * The model may only choose from the allowlist; anything else is rejected
 * and the caller falls back to the rule planner.
 */
const ALLOWED = Object.values(ACTIONS);

export function llmConfig() {
  return {
    provider: process.env.LLM_PROVIDER || 'rules',
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.1',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 8000),
  };
}

export async function llmPlan(evidence, fetchImpl = fetch) {
  const cfg = llmConfig();
  if (cfg.provider !== 'ollama') return null;

  const prompt = [
    'You are a payments support investigator. Choose exactly one action from this list:',
    ALLOWED.join(', '),
    'Respond with JSON only: {"action": "<ACTION>", "reason": "<short reason citing evidence>"}',
    'Evidence:',
    JSON.stringify(evidence),
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, prompt, format: 'json', stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const parsed = JSON.parse(body.response);
    if (!ALLOWED.includes(parsed.action)) return null;
    return { action: parsed.action, reason: `[LLM] ${String(parsed.reason || '').slice(0, 300)}` };
  } catch {
    return null; // unreachable, timeout or malformed output -> rule planner takes over
  } finally {
    clearTimeout(timer);
  }
}
