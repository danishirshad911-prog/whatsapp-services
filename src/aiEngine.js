/* global process, fetch */
/**
 * AI Engine — Cloud-first (Base44 LLM) with Ollama fallback
 * Primary: Base44 InvokeLLM (works 24/7 on Render — no Ollama needed)
 * Fallback: Local Ollama if OLLAMA_URL is configured
 * Languages: Arabic (Gulf), English, Roman Urdu — auto-detect
 */
import { buildContextPrompt, buildMemorySummarizationPrompt } from './contextBuilder.js';
import { retrieveRelevantChunks } from './ragEngine.js';
import { sendMessage, getConnectionState } from './baileys.js';
import { broadcast } from './wsServer.js';
import { publish } from './redis.js';
import { logger } from './logger.js';

const BASE44_API = process.env.BASE44_API_URL || 'https://api.base44.com/api/apps';
const BASE44_LLM_API = 'https://api.base44.com/api/integrations/invoke-llm';
const APP_ID = process.env.BASE44_APP_ID || '';
const API_KEY = process.env.BASE44_API_KEY || '';
const processedMessages = new Set();
const AI_DEDUPE_TTL = 60_000;

// ─── Language Detection ────────────────────────────────────────────────────────
function detectLanguage(text) {
  if (!text) return 'en';
  if (/[؀-ۿ]/.test(text)) return 'ar';
  const romanUrduWords = ['kya','hai','hain','kar','main','aap','nahi','bata','chahiye','theek','shukriya','price','kitna','kab','kaise','haan','ji','bhai'];
  const lower = text.toLowerCase();
  if (romanUrduWords.filter(w => lower.includes(w)).length >= 2) return 'roman_urdu';
  return 'en';
}

// ─── Cloud LLM Call (Base44) ───────────────────────────────────────────────────
async function callBase44LLM({ prompt, systemPrompt, maxTokens = 300 }) {
  if (!APP_ID || !API_KEY) throw new Error('BASE44_APP_ID or BASE44_API_KEY not set');
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
  const res = await fetch(`https://api.base44.com/api/apps/${APP_ID}/integrations/Core/InvokeLLM`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      prompt: fullPrompt,
      response_json_schema: {
        type: 'object',
        properties: { reply: { type: 'string' }, intent: { type: 'string' }, sentiment: { type: 'string' } }
      }
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) { const err = await res.text().catch(() => ''); throw new Error(`Base44 LLM: ${res.status} ${err}`); }
  const data = await res.json();
  const reply = data?.reply || data?.response || '';
  return { response: reply, latency_ms: 0, prompt_tokens: 0, completion_tokens: 0, model: 'base44-llm' };
}

// ─── Ollama fallback ───────────────────────────────────────────────────────────
async function callOllamaFallback({ model, prompt, temperature, maxTokens }) {
  const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
  const start = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature, num_predict: maxTokens } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return { response: (data.response || '').trim(), latency_ms: Date.now() - start, prompt_tokens: data.prompt_eval_count || 0, completion_tokens: data.eval_count || 0, model };
}

// ─── Smart AI call (cloud first, Ollama fallback) ─────────────────────────────
async function callAI({ model, prompt, systemPrompt, temperature, maxTokens }) {
  const start = Date.now();
  const isCloudModel = !model || model === 'base44-llm' || model === 'llama3';
  // Try cloud first
  try {
    const result = await callBase44LLM({ prompt, systemPrompt, maxTokens });
    result.latency_ms = Date.now() - start;
    return result;
  } catch (cloudErr) {
    logger.warn(`[AIEngine] Cloud LLM failed: ${cloudErr.message} — trying Ollama fallback`);
  }
  // Ollama fallback
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  return callOllamaFallback({ model: model || 'llama3', prompt: fullPrompt, temperature, maxTokens });
}

async function b44(method, entity, query = {}, data = null) {
  if (!APP_ID || !API_KEY) return null;
  const base = `${BASE44_API}/${APP_ID}/entities/${entity}`;
  let url = base;
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` } };
  if (method === 'GET') {
    const qs = new URLSearchParams();
    if (query.filter) qs.set('filter', JSON.stringify(query.filter));
    if (query.sort) qs.set('sort', query.sort);
    if (query.limit) qs.set('limit', query.limit);
    url = `${base}?${qs.toString()}`;
  } else { opts.body = JSON.stringify(data || {}); }
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) { const err = await res.text().catch(() => ''); throw new Error(`b44 ${method} ${entity}: ${res.status} ${err}`); }
  return res.json();
}

async function fetchCRMContext(phone) {
  const normalized = phone.replace('@s.whatsapp.net', '').replace(/\D/g, '');
  const [contactsRes, settingsRes] = await Promise.all([
    b44('GET', 'Contact', { filter: { phone_number: normalized }, limit: 1 }),
    b44('GET', 'AISettings', { limit: 1 }),
  ]);
  const contact = contactsRes?.items?.[0] || contactsRes?.[0] || null;
  const settings = settingsRes?.items?.[0] || settingsRes?.[0] || null;
  if (!contact) return { contact: null, settings };

  const [convRes, memoryRes, tagsRes, notesRes] = await Promise.all([
    b44('GET', 'Conversation', { filter: { contact_id: contact.id, status: 'open' }, sort: '-created_date', limit: 1 }),
    b44('GET', 'AIMemory', { filter: { contact_id: contact.id }, limit: 1 }),
    b44('GET', 'ContactTag', { filter: { contact_id: contact.id }, limit: 20 }),
    b44('GET', 'Note', { filter: { contact_id: contact.id }, sort: '-created_date', limit: 5 }),
  ]);
  const conversation = convRes?.items?.[0] || convRes?.[0] || null;
  let messages = [];
  if (conversation?.id) {
    const msgRes = await b44('GET', 'Message', { filter: { conversation_id: conversation.id }, sort: 'timestamp_wa', limit: 20 });
    messages = msgRes?.items || msgRes || [];
  }
  return { contact, conversation, messages, memory: memoryRes?.items?.[0] || memoryRes?.[0] || null, tags: tagsRes?.items || tagsRes || [], notes: notesRes?.items || notesRes || [], settings };
}

async function storeCRMReply({ conversation, contact, reply, model }) {
  if (!conversation?.id) return null;
  const ts = new Date().toISOString();
  await b44('POST', 'Message', {}, { conversation_id: conversation.id, contact_id: contact.id, direction: 'outbound', body: reply, message_type: 'text', whatsapp_message_id: `ai-${Date.now()}`, status: 'sent', agent_email: `ai-${model}`, timestamp_wa: ts });
  await b44('PUT', 'Conversation', {}, { id: conversation.id, last_message_at: ts, last_message_preview: reply.slice(0, 80), last_message_direction: 'outbound' }).catch(() => {});
}

async function updateAIMemory({ contact, messages, existingMemory, settings }) {
  if (messages.length < 5) return;
  try {
    const result = await callAI({ model: settings?.model || 'base44-llm', prompt: buildMemorySummarizationPrompt(contact, messages), temperature: 0.3, maxTokens: 400 });
    const jsonMatch = result.response.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (!parsed) return;
    const memData = { contact_id: contact.id, summary: parsed.summary || '', key_facts: parsed.key_facts || [], detected_intent: parsed.detected_intent || 'unknown', is_lead: !!parsed.is_lead, sentiment: ['positive', 'neutral', 'negative'].includes(parsed.sentiment) ? parsed.sentiment : 'unknown', last_updated: new Date().toISOString(), message_count: messages.length };
    if (existingMemory?.id) await b44('PUT', 'AIMemory', {}, { id: existingMemory.id, ...memData });
    else await b44('POST', 'AIMemory', {}, memData);
  } catch (err) { logger.warn(`[AIEngine] Memory update failed: ${err.message}`); }
}

export async function processInboundWithAI(msgEvent) {
  const { from, body, id: msgId } = msgEvent;
  if (!body?.trim()) return;
  if (msgId && processedMessages.has(msgId)) return;
  if (msgId) { processedMessages.add(msgId); setTimeout(() => processedMessages.delete(msgId), AI_DEDUPE_TTL); }

  // Detect language for better responses
  const detectedLang = detectLanguage(body);
  logger.info(`[AIEngine] Processing from ${from} [lang:${detectedLang}]: "${body.slice(0, 60)}"`);

  let context;
  try { context = await fetchCRMContext(from); } catch (err) { logger.error(`[AIEngine] Context fetch failed: ${err.message}`); return; }

  const { contact, conversation, messages, memory, tags, notes, settings } = context;
  if (!settings?.enabled) { logger.debug('[AIEngine] AI disabled globally'); return; }
  if (settings.excluded_contacts?.includes(contact?.id)) return;
  if (!contact) { logger.warn(`[AIEngine] No contact for ${from} — skipping`); return; }

  // Get RAG chunks if available
  let knowledgeChunks = [];
  try { knowledgeChunks = await retrieveRelevantChunks(body, 3); } catch {}

  // Build prompt with language context
  const contextPrompt = buildContextPrompt({ contact, messages, memory, tags, notes, conversation, settings, knowledgeChunks });

  // System prompt with language instruction
  const langInstructions = {
    ar: 'IMPORTANT: The customer is writing in Arabic. You MUST reply in Arabic (العربية). Use Gulf Arabic style.',
    roman_urdu: 'IMPORTANT: The customer is writing in Roman Urdu. You MUST reply in Roman Urdu (Urdu in English letters).',
    en: 'Reply in clear English.',
  };
  const systemWithLang = `${settings?.system_prompt || 'You are a professional CRM assistant.'}\n\n${langInstructions[detectedLang] || langInstructions.en}`;

  let aiResult;
  try {
    aiResult = await callAI({
      model: settings.model || 'base44-llm',
      prompt: contextPrompt,
      systemPrompt: systemWithLang,
      temperature: settings.temperature ?? 0.7,
      maxTokens: settings.max_tokens || 300,
    });
  } catch (err) {
    logger.error(`[AIEngine] All AI backends failed: ${err.message}`);
    await b44('POST', 'AILog', {}, { contact_id: contact?.id || '', status: 'failed', error: err.message, model: settings?.model || 'base44-llm' }).catch(() => {});
    return;
  }

  const reply = aiResult.response;
  if (!reply?.trim()) return;

  const delay = settings.auto_reply_delay_ms ?? 1500;
  if (delay > 0) await new Promise(r => setTimeout(r, delay));

  if (getConnectionState() === 'connected') {
    try { await sendMessage(from, reply); } catch (err) { logger.error(`[AIEngine] Send failed: ${err.message}`); return; }
  } else { logger.warn('[AIEngine] WhatsApp not connected — reply not sent'); return; }

  await storeCRMReply({ conversation, contact, reply, model: aiResult.model || 'base44-llm' });
  await b44('POST', 'AILog', {}, { contact_id: contact?.id || '', conversation_id: conversation?.id || '', model: aiResult.model || 'base44-llm', latency_ms: aiResult.latency_ms || 0, response: reply.slice(0, 500), status: 'success', error: '' }).catch(() => {});
  updateAIMemory({ contact, messages, existingMemory: memory, settings }).catch(() => {});
  broadcast('ai_reply_sent', { contact_id: contact.id, conversation_id: conversation?.id, reply, model: aiResult.model, lang: detectedLang });
  publish('ai.reply_sent', { contact_id: contact.id, reply, lang: detectedLang }).catch(() => {});
}
