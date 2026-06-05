import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, makeCacheableSignalKeyStore, PHONENUMBER_MCC } from '@whiskeysockets/baileys';
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
    browser: ['WA CRM', 'Chrome', '121.0.0'],
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
        || '';
      const from = msg.key.remoteJid || '';
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
      broadcast('new_message', normalized);
      await publish(CHANNELS.MESSAGE_RECEIVED, normalized).catch(() => {});
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
