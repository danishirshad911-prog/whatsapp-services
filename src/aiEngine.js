/* global process, fetch */
import { callOllama, checkOllamaHealth } from './ollama.js';
import { buildContextPrompt, buildMemorySummarizationPrompt } from './contextBuilder.js';
import { retrieveRelevantChunks } from './ragEngine.js';
import { sendMessage, getConnectionState } from './baileys.js';
import { broadcast } from './wsServer.js';
import { publish } from './redis.js';
import { logger } from './logger.js';

const BASE44_API = process.env.BASE44_API_URL || 'https://api.base44.com/api/apps';
const APP_ID = process.env.BASE44_APP_ID || '';
const API_KEY = process.env.BASE44_API_KEY || '';
const processedMessages = new Set();
const AI_DEDUPE_TTL = 60_000;

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
    const result = await callOllama({ model: settings?.model || 'llama3', prompt: buildMemorySummarizationPrompt(contact, messages), temperature: 0.3, maxTokens: 400 });
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

  logger.info(`[AIEngine] Processing from ${from}: "${body.slice(0, 60)}"`);
  let context;
  try { context = await fetchCRMContext(from); } catch (err) { logger.error(`[AIEngine] Context fetch failed: ${err.message}`); return; }

  const { contact, conversation, messages, memory, tags, notes, settings } = context;
  if (!settings?.enabled) return;
  if (settings.excluded_contacts?.includes(contact?.id)) return;
  if (!contact) return;

  const ollamaHealth = await checkOllamaHealth();
  if (!ollamaHealth.healthy) { logger.error('[AIEngine] Ollama not reachable'); return; }

  let knowledgeChunks = [];
  try { knowledgeChunks = await retrieveRelevantChunks(body, 5); } catch {}

  const fullPrompt = buildContextPrompt({ contact, messages, memory, tags, notes, conversation, settings, knowledgeChunks });

  let ollamaResult;
  try { ollamaResult = await callOllama({ model: settings.model || 'llama3', prompt: fullPrompt, temperature: settings.temperature ?? 0.7, maxTokens: settings.max_tokens || 300 }); }
  catch (err) { logger.error(`[AIEngine] Ollama failed: ${err.message}`); return; }

  const reply = ollamaResult.response;
  if (!reply?.trim()) return;

  const delay = settings.auto_reply_delay_ms ?? 1500;
  if (delay > 0) await new Promise(r => setTimeout(r, delay));

  if (getConnectionState() === 'connected') {
    try { await sendMessage(from, reply); } catch (err) { logger.error(`[AIEngine] Send failed: ${err.message}`); return; }
  } else return;

  await storeCRMReply({ conversation, contact, reply, model: settings?.model || 'llama3' });
  await b44('POST', 'AILog', {}, { contact_id: contact?.id || '', conversation_id: conversation?.id || '', model: settings?.model || '', latency_ms: ollamaResult?.latency_ms || 0, prompt_tokens: ollamaResult?.prompt_tokens || 0, completion_tokens: ollamaResult?.completion_tokens || 0, response: reply.slice(0, 500), status: 'success', error: '' }).catch(() => {});
  updateAIMemory({ contact, messages, existingMemory: memory, settings }).catch(() => {});
  broadcast('ai_reply_sent', { contact_id: contact.id, conversation_id: conversation?.id, reply, model: settings?.model, latency_ms: ollamaResult.latency_ms });
  await publish('ai.reply_sent', { contact_id: contact.id, conversation_id: conversation?.id, reply, latency_ms: ollamaResult.latency_ms });
}
