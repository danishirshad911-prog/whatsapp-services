import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

let pubClient = null;
let subClient = null;

export const CHANNELS = {
  CONNECTED: 'whatsapp.connected',
  DISCONNECTED: 'whatsapp.disconnected',
  QR_GENERATED: 'whatsapp.qr_generated',
  MESSAGE_RECEIVED: 'whatsapp.message_received',
  MESSAGE_SENT: 'whatsapp.message_sent',
  SESSION_RESTORED: 'whatsapp.session_restored',
  RECONNECTING: 'whatsapp.reconnecting',
  AUTH_FAILED: 'whatsapp.auth_failed',
  LEAD_DETECTED: 'lead.detected',
  LEAD_UPDATED: 'lead.updated',
  AUTOMATION_TRIGGERED: 'automation.triggered',
  AGENT_ASSIGNED: 'agent.assigned',
  CAMPAIGN_CREATED: 'campaign.created',
  CAMPAIGN_STARTED: 'campaign.started',
  CAMPAIGN_PAUSED: 'campaign.paused',
  CAMPAIGN_COMPLETED: 'campaign.completed',
  CAMPAIGN_FAILED: 'campaign.failed',
  CAMPAIGN_MESSAGE_SENT: 'campaign.message_sent',
};

function createRedisClient(name) {
  const client = new Redis(config.redis.url, {
    retryStrategy: (times) => times > config.redis.maxRetries ? null : config.redis.retryDelay,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  client.on('connect', () => logger.info(`[Redis:${name}] Connected`));
  client.on('error', (err) => logger.warn(`[Redis:${name}] Error: ${err.message}`));
  return client;
}

export async function connectRedis() {
  try {
    pubClient = createRedisClient('pub');
    subClient = createRedisClient('sub');
    await Promise.all([pubClient.connect(), subClient.connect()]);
    logger.info('[Redis] Pub/Sub clients ready');
    return true;
  } catch (err) {
    logger.warn(`[Redis] Could not connect: ${err.message}`);
    pubClient = null; subClient = null;
    return false;
  }
}

export async function publish(channel, data) {
  if (!pubClient) return;
  try { await pubClient.publish(channel, JSON.stringify({ channel, data, ts: Date.now() })); }
  catch (err) { logger.warn(`[Redis] Publish failed: ${err.message}`); }
}

export function subscribe(channel, handler) {
  if (!subClient) return;
  subClient.subscribe(channel, (err) => { if (err) logger.warn('[Redis] Subscribe failed'); });
  subClient.on('message', (ch, message) => {
    if (ch === channel) { try { handler(JSON.parse(message)); } catch {} }
  });
}

export function isRedisConnected() { return pubClient?.status === 'ready'; }
export function getRedisClient() { return pubClient; }
