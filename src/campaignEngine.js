/* global process, fetch, setTimeout, clearTimeout */
import { sendMessage, getConnectionState } from './baileys.js';
import { publish } from './redis.js';
import { logger } from './logger.js';

const BASE44_API = process.env.BASE44_API_URL || 'https://api.base44.com/api/apps';
const APP_ID = process.env.BASE44_APP_ID || '';
const API_KEY = process.env.BASE44_API_KEY || '';
const runningCampaigns = new Map();

async function b44(method, entity, query = {}, data = null) {
  if (!APP_ID || !API_KEY) return null;
  const base = `${BASE44_API}/${APP_ID}/entities/${entity}`;
  let url = base;
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` } };
  if (method === 'GET') { const qs = new URLSearchParams(); if (query.filter) qs.set('filter', JSON.stringify(query.filter)); if (query.sort) qs.set('sort', query.sort); if (query.limit) qs.set('limit', String(query.limit)); url = `${base}?${qs.toString()}`; }
  else { opts.body = JSON.stringify(data || {}); }
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) { const err = await res.text().catch(() => ''); throw new Error(`b44 ${method} ${entity}: ${res.status} ${err}`); }
  return res.json();
}

export async function buildAudience(campaign) {
  const res = await b44('GET', 'Contact', { limit: 5000 });
  let contacts = res?.items || res || [];
  switch (campaign.segment) {
    case 'hot': contacts = contacts.filter(c => c.lead_status === 'hot'); break;
    case 'warm': contacts = contacts.filter(c => c.lead_status === 'warm'); break;
    case 'cold': contacts = contacts.filter(c => c.lead_status === 'cold'); break;
    case 'customer': contacts = contacts.filter(c => c.lead_status === 'customer'); break;
    case 'tagged': if (campaign.segment_tag) { const tagRes = await b44('GET', 'ContactTag', { filter: { tag_name: campaign.segment_tag }, limit: 5000 }); const ids = new Set((tagRes?.items || tagRes || []).map(t => t.contact_id)); contacts = contacts.filter(c => ids.has(c.id)); } break;
  }
  contacts = contacts.filter(c => c.status !== 'blocked' && c.phone_number);
  const prefRes = await b44('GET', 'ContactPreference', { filter: { marketing_opt_out: true }, limit: 5000 });
  const optedOut = new Set((prefRes?.items || prefRes || []).map(p => p.contact_id));
  return contacts.filter(c => !optedOut.has(c.id));
}

function personalizeMessage(template, contact) {
  return template.replace(/\{\{contact_name\}\}/gi, contact.name || contact.push_name || 'there').replace(/\{\{phone\}\}/gi, contact.phone_number || '').replace(/\{\{first_name\}\}/gi, (contact.name || '').split(' ')[0] || 'there');
}

async function logEvent(campaignId, eventType, details, contactId = '', meta = {}) {
  await b44('POST', 'CampaignLog', {}, { campaign_id: campaignId, event_type: eventType, details, contact_id: contactId, meta }).catch(() => {});
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runCampaign(campaignId) {
  runningCampaigns.set(campaignId, { paused: false, cancelled: false });
  const campRes = await b44('GET', `Campaign/${campaignId}`);
  const campaign = campRes?.item || campRes;
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  const contacts = await buildAudience(campaign);
  if (!contacts.length) { await b44('PUT', 'Campaign', {}, { id: campaignId, status: 'completed', completed_at: new Date().toISOString(), total_recipients: 0 }); runningCampaigns.delete(campaignId); return; }
  const existingRes = await b44('GET', 'CampaignRecipient', { filter: { campaign_id: campaignId }, limit: 5000 });
  const existingMap = new Map((existingRes?.items || existingRes || []).map(r => [r.contact_id, r]));
  for (const contact of contacts.filter(c => !existingMap.has(c.id))) {
    const rec = await b44('POST', 'CampaignRecipient', {}, { campaign_id: campaignId, contact_id: contact.id, contact_phone: contact.phone_number, contact_name: contact.name || '', delivery_status: 'pending', personalized_message: personalizeMessage(campaign.message_template, contact), retry_count: 0 }).catch(() => null);
    if (rec) existingMap.set(contact.id, rec?.item || rec);
  }
  const pendingRes = await b44('GET', 'CampaignRecipient', { filter: { campaign_id: campaignId, delivery_status: 'pending' }, limit: 5000 });
  const pendingRecipients = pendingRes?.items || pendingRes || [];
  await b44('PUT', 'Campaign', {}, { id: campaignId, status: 'running', started_at: new Date().toISOString(), total_recipients: pendingRecipients.length, sent_count: 0, failed_count: 0 });
  await logEvent(campaignId, 'started', `Starting with ${pendingRecipients.length} recipients`);
  await publish('campaign.started', { campaign_id: campaignId, total: pendingRecipients.length });
  const intervalMs = Math.ceil(60_000 / (campaign.rate_limit_per_min || 20));
  let sentCount = 0, failedCount = 0;
  for (const recipient of pendingRecipients) {
    const state = runningCampaigns.get(campaignId);
    if (state?.cancelled) { await b44('PUT', 'Campaign', {}, { id: campaignId, status: 'cancelled' }); runningCampaigns.delete(campaignId); return; }
    while (runningCampaigns.get(campaignId)?.paused) { await sleep(2000); if (runningCampaigns.get(campaignId)?.cancelled) break; }
    if (getConnectionState() !== 'connected') { await b44('PUT', 'CampaignRecipient', {}, { id: recipient.id, delivery_status: 'failed', failure_reason: 'WhatsApp not connected' }); failedCount++; continue; }
    const message = recipient.personalized_message || personalizeMessage(campaign.message_template, { name: recipient.contact_name, phone_number: recipient.contact_phone });
    try {
      await sendMessage(`${recipient.contact_phone}@s.whatsapp.net`, message);
      await b44('PUT', 'CampaignRecipient', {}, { id: recipient.id, delivery_status: 'sent', sent_at: new Date().toISOString() });
      await publish('campaign.message_sent', { campaign_id: campaignId, contact_id: recipient.contact_id, phone: recipient.contact_phone });
      sentCount++;
    } catch (err) {
      await b44('PUT', 'CampaignRecipient', {}, { id: recipient.id, delivery_status: 'failed', failure_reason: err.message, retry_count: (recipient.retry_count || 0) + 1 });
      failedCount++;
    }
    if ((sentCount + failedCount) % 10 === 0) await b44('PUT', 'Campaign', {}, { id: campaignId, sent_count: sentCount, failed_count: failedCount });
    await sleep(intervalMs);
  }
  await b44('PUT', 'Campaign', {}, { id: campaignId, status: 'completed', completed_at: new Date().toISOString(), sent_count: sentCount, failed_count: failedCount });
  await logEvent(campaignId, 'completed', `Done. Sent: ${sentCount}, Failed: ${failedCount}`);
  await publish('campaign.completed', { campaign_id: campaignId, sent: sentCount, failed: failedCount });
  runningCampaigns.delete(campaignId);
}

export function pauseCampaign(campaignId) { if (runningCampaigns.has(campaignId)) runningCampaigns.get(campaignId).paused = true; }
export function resumeCampaign(campaignId) { if (runningCampaigns.has(campaignId)) runningCampaigns.get(campaignId).paused = false; }
export function cancelCampaign(campaignId) { if (runningCampaigns.has(campaignId)) runningCampaigns.get(campaignId).cancelled = true; }
export function isCampaignRunning(campaignId) { return runningCampaigns.has(campaignId); }

export function startCampaignScheduler() {
  const check = async () => {
    try {
      const now = new Date().toISOString();
      const res = await b44('GET', 'Campaign', { filter: { status: 'scheduled' }, limit: 50 });
      for (const campaign of (res?.items || res || [])) {
        if (campaign.scheduled_at && campaign.scheduled_at <= now) runCampaign(campaign.id).catch(() => {});
      }
    } catch {}
  };
  check();
  return setInterval(check, 60_000);
}
