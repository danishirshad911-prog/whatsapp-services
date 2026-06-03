/* global process, fetch */
import { logger } from './logger.js';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function checkOllamaHealth() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { healthy: false, models: [] };
    const data = await res.json();
    return { healthy: true, models: (data.models || []).map(m => m.name), url: OLLAMA_URL };
  } catch (err) {
    return { healthy: false, models: [], error: err.message };
  }
}

export async function callOllama({ model = 'llama3', system, prompt, temperature = 0.7, maxTokens = 300 }) {
  const start = Date.now();
  const body = {
    model,
    prompt: system ? `${system}\n\n${prompt}` : prompt,
    stream: false,
    options: { temperature, num_predict: maxTokens, stop: ['\n\nHuman:', '\n\nUser:'] },
  };
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) { const text = await res.text().catch(() => ''); throw new Error(`Ollama error ${res.status}: ${text}`); }
  const data = await res.json();
  const response = (data.response || '').trim();
  logger.info(`[Ollama] Generated ${response.length} chars in ${Date.now() - start}ms`);
  return { response, latency_ms: Date.now() - start, prompt_tokens: data.prompt_eval_count || 0, completion_tokens: data.eval_count || 0, model };
}

export async function pullModel(modelName) {
  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: false }), signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Pull failed: ${res.statusText}`);
  return res.json();
}
