import { default as makeWASocket, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
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

export function getConnectionState() { return connectionState; }
export function getPhoneNumber() { return phoneNumber; }
export function getDeviceInfo() { return deviceInfo; }
export function getSocket() { return sock; }

export async function startSession(sessionId = 'default') {
  clearTimeout(reconnectTimer);
  const store = new SessionStore(sessionId);
  const { state, saveCreds } = createAuthState(store);
  const { version } = await fetchLatestBaileysVersion();
  connectionState = 'connecting';
  broadcast('connection_status', { status: 'connecting' });

  sock = makeWASocket({
    version,
    logger: logger.child({ module: 'baileys' }),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: 'keys' })) },
    msgRetryCounterCache: msgRetryCache,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: jid => isJidBroadcast(jid),
    browser: ['WA CRM System', 'Chrome', '10.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionState = 'qr_pending';
      const qrImage = await qrcode.toDataURL(qr).catch(() => null);
      broadcast('qr_code', { qr, qrImage });
      await publish(CHANNELS.QR_GENERATED, { qr, ts: Date.now() });
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
      connectionState = 'disconnected';
      broadcast('connection_status', { status: 'disconnected', code });
      await publish(CHANNELS.DISCONNECTED, { code });
      if (code !== DisconnectReason.loggedOut) scheduleReconnect(sessionId, code === DisconnectReason.restartRequired);
      else { store.clear(); broadcast('connection_status', { status: 'logged_out' }); }
    }
    if (connection === 'open') {
      reconnectAttempts = 0;
      connectionState = 'connected';
      phoneNumber = sock.user?.id?.split(':')[0] || '';
      deviceInfo = { platform: sock.user?.platform || 'web', device: 'WhatsApp Web', pushName: sock.user?.name || '' };
      broadcast('connection_status', { status: 'open', phone: phoneNumber, device: deviceInfo });
      await publish(CHANNELS.CONNECTED, { phone: phoneNumber, device: deviceInfo });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      if (!msg.message || msg.key.fromMe) continue;
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
      const from = msg.key.remoteJid || '';
      const normalized = { id: msg.key.id, from, to: sock.user?.id || '', body, type: 'text', timestamp: msg.messageTimestamp, pushName: msg.pushName || '', raw: msg };
      broadcast('new_message', normalized);
      await publish(CHANNELS.MESSAGE_RECEIVED, normalized);
      processInboundWithAI(normalized).catch(err => logger.error(`[AIEngine] ${err.message}`));
      processLeadPipeline(normalized).catch(err => logger.error(`[LeadEngine] ${err.message}`));
    }
  });

  return sock;
}

function scheduleReconnect(sessionId, immediate = false) {
  if (reconnectAttempts >= config.reconnect.maxAttempts) { connectionState = 'failed'; broadcast('connection_status', { status: 'failed' }); return; }
  reconnectAttempts++;
  const delay = immediate ? 500 : config.reconnect.delayMs * reconnectAttempts;
  connectionState = 'connecting';
  broadcast('connection_status', { status: 'reconnecting', attempt: reconnectAttempts });
  reconnectTimer = setTimeout(() => startSession(sessionId), delay);
}

export async function sendMessage(to, body) {
  if (!sock || connectionState !== 'connected') throw new Error('WhatsApp not connected');
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  const result = await sock.sendMessage(jid, { text: body });
  await publish(CHANNELS.MESSAGE_SENT, { to: jid, body, messageId: result.key.id });
  return { messageId: result.key.id, to: jid };
}

export async function disconnect() {
  clearTimeout(reconnectTimer);
  if (sock) { await sock.logout().catch(() => {}); sock = null; }
  connectionState = 'disconnected';
  broadcast('connection_status', { status: 'disconnected' });
}

export async function forceReconnect(sessionId = 'default') {
  if (sock) { try { sock.ev.removeAllListeners(); } catch {} try { await sock.ws?.close(); } catch {} sock = null; }
  reconnectAttempts = 0;
  return startSession(sessionId);
}
