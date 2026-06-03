/* global process */
import { callOllama } from './ollama.js';
import { broadcast } from './wsServer.js';
import { publish } from './redis.js';
import { logger } from './logger.js';
import { sendMessage, getConnectionState } from './baileys.js';

const BASE44_API = process.env.BASE44_API_URL || 'https://api.base44.com/api/apps';
const APP_ID = process.env.BASE44_APP_ID || '';
const API_KEY = process.env.BASE44_API_KEY || '';

async function b44(method, entity, query = {}, data = null) {
  if (!APP_ID || !API_KEY) return null;
  const base = `${BASE44_API}/${APP_ID}/entities/${entity}`;
  let url = base;
  const opts = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` } };
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

async function fetchLeadContext(phone) {
  const normalized = phone.replace('@s.whatsapp.net', '').replace(/\D/g, '');
  const [contactsRes, settingsRes] = await Promise.all([b44('GET', 'Contact', { filter: { phone_number: normalized }, limit: 1 }), b44('GET', 'AISettings', { limit: 1 })]);
  const contact = contactsRes?.items?.[0] || contactsRes?.[0] || null;
  const settings = settingsRes?.items?.[0] || settingsRes?.[0] || null;
  if (!contact) return { contact: null, settings };
  const [convRes, memoryRes, tagsRes] = await Promise.all([b44('GET', 'Conversation', { filter: { contact_id: contact.id, status: 'open' }, sort: '-created_date', limit: 1 }), b44('GET', 'AIMemory', { filter: { contact_id: contact.id }, limit: 1 }), b44('GET', 'ContactTag', { filter: { contact_id: contact.id }, limit: 20 })]);
  const conversation = convRes?.items?.[0] || convRes?.[0] || null;
  let messages = [];
  if (conversation?.id) { const msgRes = await b44('GET', 'Message', { filter: { conversation_id: conversation.id }, sort: 'timestamp_wa', limit: 30 }); messages = msgRes?.items || msgRes || []; }
  return { contact, conversation, messages, memory: memoryRes?.items?.[0] || memoryRes?.[0] || null, tags: tagsRes?.items || tagsRes || [], settings };
}

function buildLeadPrompt(contact, messages, memory, currentMessage) {
  const history = messages.slice(-15).map(m => `[${m.direction === 'inbound' ? 'Customer' : 'Agent'}]: ${m.body || ''}`).join('\n');
  const memCtx = memory?.summary ? `\nPrevious Summary: ${memory.summary}` : '';
  return `You are an expert CRM lead analyst. Analyze this WhatsApp conversation.
Contact: ${contact.name || contact.phone_number}
Current message: "${currentMessage}"${memCtx}
History:\n${history || 'No prior history'}

Respond ONLY with valid JSON:
{"intent":"buying|pricing_inquiry|support|general_inquiry|complaint|unknown","lead_status":"hot|warm|cold|customer","lead_score":<0-100>,"urgency":"high|medium|low","buying_signals":[],"reason":"1-2 sentences","recommended_action":"auto_reply|assign_agent|follow_up|tag_only|none","suggested_tags":[],"sentiment":"positive|neutral|negative"}

SCORING: 80-100=Hot(explicit buy intent), 60-79=Warm(interested), 30-59=Cold(browsing), 0-29=No signal`;
}

function parseClassification(raw) {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const p = JSON.parse(jsonMatch[0]);
    return { intent: ['buying','pricing_inquiry','support','general_inquiry','complaint','unknown'].includes(p.intent) ? p.intent : 'unknown', lead_status: ['hot','warm','cold','customer'].includes(p.lead_status) ? p.lead_status : 'cold', lead_score: Math.max(0, Math.min(100, Number(p.lead_score) || 0)), urgency: ['high','medium','low'].includes(p.urgency) ? p.urgency : 'low', buying_signals: Array.isArray(p.buying_signals) ? p.buying_signals : [], reason: p.reason || '', recommended_action: p.recommended_action || 'none', suggested_tags: Array.isArray(p.suggested_tags) ? p.suggested_tags.slice(0, 5) : [], sentiment: ['positive','neutral','negative'].includes(p.sentiment) ? p.sentiment : 'neutral' };
  } catch { return null; }
}

function applyHeuristicBoost(c, msg, count) {
  const m = msg.toLowerCase();
  let adj = 0;
  if (['price','cost','how much','buy','purchase','order','payment','delivery','shipping','available'].some(kw => m.includes(kw))) adj += 10;
  if (['interested','info','details','more','demo','show','catalog','options'].some(kw => m.includes(kw))) adj += 5;
  if (count <= 2) adj += 5;
  if (c.urgency === 'high') adj += 10;
  if (c.urgency === 'medium') adj += 5;
  const finalScore = Math.max(0, Math.min(100, c.lead_score + adj));
  let finalStatus = c.lead_status;
  if (finalScore >= 80) finalStatus = 'hot';
  else if (finalScore >= 60) finalStatus = 'warm';
  else if (finalScore >= 20) finalStatus = 'cold';
  return { ...c, lead_score: finalScore, lead_status: finalStatus };
}

async function applyTag(contactId, tagName, tagColor = '#6366f1') {
  let tagsRes = await b44('GET', 'Tag', { filter: { name: tagName }, limit: 1 }).catch(() => null);
  let tag = tagsRes?.items?.[0] || tagsRes?.[0] || null;
  if (!tag) tag = await b44('POST', 'Tag', {}, { name: tagName, color: tagColor }).catch(() => null);
  if (!tag?.id) return;
  const existing = await b44('GET', 'ContactTag', { filter: { contact_id: contactId, tag_id: tag.id }, limit: 1 }).catch(() => null);
  if ((existing?.items || existing || []).length > 0) return;
  await b44('POST', 'ContactTag', {}, { contact_id: contactId, tag_id: tag.id, tag_name: tag.name, tag_color: tag.color }).catch(() => {});
}

async function logAutomation(contactId, convId, trigger, action, detail, cls) {
  await b44('POST', 'AutomationLog', {}, { contact_id: contactId, conversation_id: convId || '', trigger_type: trigger, action_taken: action, action_detail: detail, lead_status: cls?.lead_status || 'unknown', lead_score: cls?.lead_score || 0, ai_intent: cls?.intent || '', success: true }).catch(() => {});
}

export async function processLeadPipeline(msgEvent) {
  const { from, body } = msgEvent;
  if (!body?.trim()) return;

  let ctx;
  try { ctx = await fetchLeadContext(from); } catch (err) { logger.error(`[LeadEngine] Context fetch failed: ${err.message}`); return; }

  const { contact, conversation, messages, memory, settings } = ctx;
  if (!contact) return;

  const modelName = settings?.model || 'llama3';
  let rawClassification = null;
  try {
    const result = await callOllama({ model: modelName, prompt: buildLeadPrompt(contact, messages, memory, body), temperature: 0.2, maxTokens: 400 });
    rawClassification = parseClassification(result.response);
  } catch (err) { logger.warn(`[LeadEngine] AI classification failed: ${err.message}`); }

  if (!rawClassification) {
    const msgLower = body.toLowerCase();
    let score = 10;
    if (['price','buy','purchase','order','cost','payment','how much','delivery'].some(kw => msgLower.includes(kw))) score = 80;
    else if (['interested','info','details','more','show','demo','catalog'].some(kw => msgLower.includes(kw))) score = 55;
    rawClassification = { intent: 'unknown', lead_status: score >= 80 ? 'hot' : score >= 60 ? 'warm' : 'cold', lead_score: score, urgency: 'low', buying_signals: [], reason: 'Fallback keyword scoring', recommended_action: 'none', suggested_tags: [], sentiment: 'neutral' };
  }

  const classification = applyHeuristicBoost(rawClassification, body, messages.length);
  logger.info(`[LeadEngine] ${classification.lead_status} (score: ${classification.lead_score}) intent: ${classification.intent}`);

  await b44('PUT', 'Contact', {}, { id: contact.id, lead_status: classification.lead_status, lead_score: classification.lead_score, last_classified_at: new Date().toISOString() }).catch(() => {});

  const convId = conversation?.id || null;

  if (classification.lead_score >= 80) {
    await applyTag(contact.id, 'Hot Lead', '#ef4444');
    await logAutomation(contact.id, convId, 'new_message', 'add_tag', 'Hot Lead', classification);
    broadcast('lead_alert', { type: 'hot_lead', contact_id: contact.id, contact_name: contact.name, lead_score: classification.lead_score, intent: classification.intent, reason: classification.reason });
    await publish('lead.detected', { contact_id: contact.id, lead_status: 'hot', lead_score: classification.lead_score });
  } else if (classification.lead_score >= 60) {
    await applyTag(contact.id, 'Warm Lead', '#f59e0b');
    await b44('POST', 'FollowUpTask', {}, { contact_id: contact.id, conversation_id: convId || '', title: `Follow up — ${classification.intent} (score: ${classification.lead_score})`, due_at: new Date(Date.now() + 86400000).toISOString(), status: 'pending', created_by_automation: true, lead_status_at_creation: classification.lead_status }).catch(() => {});
    await publish('lead.detected', { contact_id: contact.id, lead_status: 'warm', lead_score: classification.lead_score });
  } else if (classification.lead_score >= 20) {
    await applyTag(contact.id, 'Cold Lead', '#6366f1');
    await publish('lead.detected', { contact_id: contact.id, lead_status: 'cold', lead_score: classification.lead_score });
  }

  const intentTagMap = { pricing_inquiry: { name: 'Pricing Asked', color: '#8b5cf6' }, buying: { name: 'Interested', color: '#10b981' }, support: { name: 'Support', color: '#3b82f6' }, complaint: { name: 'Complaint', color: '#ef4444' } };
  if (intentTagMap[classification.intent]) await applyTag(contact.id, intentTagMap[classification.intent].name, intentTagMap[classification.intent].color);

  broadcast('lead_updated', { contact_id: contact.id, conversation_id: convId, lead_status: classification.lead_status, lead_score: classification.lead_score, intent: classification.intent, sentiment: classification.sentiment, reason: classification.reason });
}
