import makeWASocket from '@whiskeysockets/baileys';
import { DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import NodeCache from 'node-cache';
import { logger } from './logger.js';
import { config } from './config.js';
import { SessionStore, createAuthState } from './sessionStore.js';
import { broadcast } from './wsServer.js';
import { publish, CHANNELS } from './redis.js';
import { processInboundWithAI } from './aiEngine.js';
import { processLeadPipeline } from './leadEngine.js';

const msgRetryCache = new NodeCache({ stdTTL: 3600 });
let sock = null;
let connectionState = 'disconnected';
let phoneNumber = '';
let deviceInfo = {};
let reconnectAttempts = 0;
let reconnectTimer = null;
let currentStore = null;

export function getConnectionState() { return connectionState; }
export function getPhoneNumber() { return phoneNumber; }
export function getDeviceInfo() { return deviceInfo; }
export function getSocket() { return sock; }

// ─── Direct Base44 CRM save (no Redis needed) ────────────────────────────────
const BASE44_API_URL = process.env.BASE44_API_URL || 'https://api.base44.com/api/apps';
const BASE44_APP_ID = process.env.BASE44_APP_ID || '';
const BASE44_API_KEY = process.env.BASE44_API_KEY || '';

async function b44Post(entity, data) {
  if (!BASE44_APP_ID || !BASE44_API_KEY) return null;
  const res = await fetch(`${BASE44_API_URL}/${BASE44_APP_ID}/entities/${entity}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BASE44_API_KEY}` },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`b44 POST ${entity}: ${res.status}`);
  return res.json();
}

async function b44Get(entity, filter = {}, limit = 1) {
  if (!BASE44_APP_ID || !BASE44_API_KEY) return [];
  const qs = new URLSearchParams({ filter: JSON.stringify(filter), limit: String(limit) });
  const res = await fetch(`${BASE44_API_URL}/${BASE44_APP_ID}/entities/${entity}?${qs}`, {
    headers: { 'Authorization': `Bearer ${BASE44_API_KEY}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.items || data || [];
}

async function b44Put(entity, id, data) {
  if (!BASE44_APP_ID || !BASE44_API_KEY) return null;
  const res = await fetch(`${BASE44_API_URL}/${BASE44_APP_ID}/entities/${entity}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BASE44_API_KEY}` },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`b44 PUT ${entity}: ${res.status}`);
  return res.json();
}

async function saveToCRM(normalized) {
  const phone = normalized.from.replace('@s.whatsapp.net', '').replace(/\D/g, '');
  const ts = normalized.timestamp ? new Date(normalized.timestamp * 1000).toISOString() : new Date().toISOString();

  // 1. Find or create Contact
  let contacts = await b44Get('Contact', { phone_number: phone }, 1);
  let contact = contacts[0];
  if (!contact) {
    contact = await b44Post('Contact', {
      phone_number: phone,
      name: normalized.pushName || phone,
      push_name: normalized.pushName || '',
      status: 'active',
      unread_count: 0,
      last_message_at: ts,
      last_message_preview: (normalized.body || '').slice(0, 80),
    });
    logger.info(`[CRM] New contact created: ${phone}`);
  } else {
    b44Put('Contact', contact.id, {
      last_message_at: ts,
      last_message_preview: (normalized.body || '').slice(0, 80),
      unread_count: (contact.unread_count || 0) + 1,
      name: (!contact.name || contact.name === phone) && normalized.pushName ? normalized.pushName : contact.name,
    }).catch(() => {});
  }
  if (!contact?.id) return;

  // 2. Find or create open Conversation
  let convs = await b44Get('Conversation', { contact_id: contact.id, status: 'open' }, 1);
  let conversation = convs[0];
  if (!conversation) {
    conversation = await b44Post('Conversation', {
      contact_id: contact.id,
      contact_phone: phone,
      status: 'open',
      unread_count: 1,
      session_id: 'default',
      last_message_at: ts,
      last_message_preview: (normalized.body || '').slice(0, 80),
      last_message_direction: 'inbound',
    });
    logger.info(`[CRM] New conversation created for: ${phone}`);
  } else {
    b44Put('Conversation', conversation.id, {
      last_message_at: ts,
      last_message_preview: (normalized.body || '').slice(0, 80),
      last_message_direction: 'inbound',
      unread_count: (conversation.unread_count || 0) + 1,
      status: 'open',
    }).catch(() => {});
  }
  if (!conversation?.id) return;

  // 3. Save Message
  await b44Post('Message', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    direction: 'inbound',
    body: normalized.body || '',
    message_type: 'text',
    whatsapp_message_id: normalized.id || `in-${Date.now()}`,
    status: 'delivered',
    timestamp_wa: ts,
  });

  logger.info(`[CRM] Message saved for ${phone}: "${(normalized.body || '').slice(0, 40)}"`);
}

export async function startSession(sessionId = 'default') {
  clearTimeout(reconnectTimer);

  const store = new SessionStore(sessionId);
  currentStore = store;

  // CRITICAL: createAuthState now uses initAuthCreds() for fresh sessions
  const { state, saveCreds } = createAuthState(store);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
    logger.info(`[Baileys] Using WA version: ${version.join('.')}`);
  } catch (err) {
    // Fallback to a known stable version if fetch fails
    version = [2, 3000, 1023028234];
    logger.warn(`[Baileys] Could not fetch latest version, using fallback: ${version.join('.')}`);
  }

  connectionState = 'connecting';
  broadcast('connection_status', { status: 'connecting' });

  // Use makeCacheableSignalKeyStore for proper key caching
  const cachedKeys = makeCacheableSignalKeyStore(state.keys, logger.child({ level: 'silent' }));

  sock = makeWASocket({
    version,
    logger: logger.child({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: cachedKeys,
    },
    msgRetryCounterCache: msgRetryCache,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: jid => isJidBroadcast(jid),
    browser: ['Chrome', 'Chrome', '121.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    retryRequestDelayMs: 2000,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = 'qr_pending';
      logger.info('[Baileys] QR code generated — broadcasting to clients');
      let qrImage = null;
      try { qrImage = await qrcode.toDataURL(qr); } catch {}
      broadcast('qr_code', { qr, qrImage });
      await publish(CHANNELS.QR_GENERATED, { qr, ts: Date.now() }).catch(() => {});
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 0;
      const reason = DisconnectReason[statusCode] || statusCode;
      logger.warn(`[Baileys] Connection closed — reason: ${reason} (${statusCode})`);

      connectionState = 'disconnected';
      broadcast('connection_status', { status: 'disconnected', code: statusCode });
      await publish(CHANNELS.DISCONNECTED, { code: statusCode }).catch(() => {});

      if (statusCode === DisconnectReason.loggedOut) {
        logger.info('[Baileys] Logged out — clearing session');
        store.clear();
        broadcast('connection_status', { status: 'logged_out' });
      } else if (statusCode === DisconnectReason.badSession || statusCode === 500) {
        // Bad/corrupt session — clear and start fresh
        logger.warn('[Baileys] Bad session detected — clearing and restarting');
        store.clear();
        reconnectAttempts = 0;
        scheduleReconnect(sessionId, true);
      } else {
        scheduleReconnect(sessionId, statusCode === DisconnectReason.restartRequired);
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      connectionState = 'connected';
      phoneNumber = sock.user?.id?.split(':')[0] || '';
      deviceInfo = {
        platform: sock.user?.platform || 'web',
        device: 'WhatsApp Web',
        pushName: sock.user?.name || '',
      };
      logger.info(`[Baileys] Connected as +${phoneNumber} (${deviceInfo.pushName})`);
      broadcast('connection_status', { status: 'open', phone: phoneNumber, device: deviceInfo });
      await publish(CHANNELS.CONNECTED, { phone: phoneNumber, device: deviceInfo }).catch(() => {});
    }
  });

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      if (!msg.message || msg.key.fromMe) continue;
      const body = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || '';
      const from = msg.key.remoteJid || '';
      // Skip group messages
      if (from.endsWith('@g.us') || from.endsWith('@broadcast')) continue;
      const normalized = {
        id: msg.key.id,
        from,
        to: sock.user?.id || '',
        body,
        type: 'text',
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName || '',
        raw: msg,
      };
      // Broadcast via WebSocket (frontend CRM picks this up)
      broadcast('new_message', normalized);
      // Publish to Redis if available (non-blocking)
      publish(CHANNELS.MESSAGE_RECEIVED, normalized).catch(() => {});
      // Save directly to Base44 WhatsAppMessage entity (Redis-independent)
      saveToCRM(normalized).catch(err => logger.error(`[Baileys] CRM save: ${err.message}`));
      // AI + Lead pipeline (non-blocking)
      processInboundWithAI(normalized).catch(err => logger.error(`[AIEngine] ${err.message}`));
      processLeadPipeline(normalized).catch(err => logger.error(`[LeadEngine] ${err.message}`));
    }
  });

  return sock;
}

function scheduleReconnect(sessionId, immediate = false) {
  if (reconnectAttempts >= config.reconnect.maxAttempts) {
    connectionState = 'failed';
    broadcast('connection_status', { status: 'failed' });
    logger.error(`[Baileys] Max reconnect attempts (${config.reconnect.maxAttempts}) reached`);
    return;
  }
  reconnectAttempts++;
  const delay = immediate ? 1000 : Math.min(config.reconnect.delayMs * reconnectAttempts, 30_000);
  connectionState = 'reconnecting';
  broadcast('connection_status', { status: 'reconnecting', attempt: reconnectAttempts });
  logger.info(`[Baileys] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => startSession(sessionId), delay);
}

export async function sendMessage(to, body) {
  if (!sock || connectionState !== 'connected') throw new Error('WhatsApp not connected');
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  const result = await sock.sendMessage(jid, { text: body });
  await publish(CHANNELS.MESSAGE_SENT, { to: jid, body, messageId: result.key.id }).catch(() => {});
  return { messageId: result.key.id, to: jid };
}

export async function disconnect() {
  clearTimeout(reconnectTimer);
  if (sock) {
    try { await sock.logout(); } catch {}
    try { sock.ev.removeAllListeners(); } catch {}
    sock = null;
  }
  connectionState = 'disconnected';
  broadcast('connection_status', { status: 'disconnected' });
}

export async function forceReconnect(sessionId = 'default') {
  logger.info('[Baileys] Force reconnect triggered');
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { await sock.ws?.close(); } catch {}
    try { await sock.end(undefined); } catch {}
    sock = null;
  }
  reconnectAttempts = 0;
  return startSession(sessionId);
}
