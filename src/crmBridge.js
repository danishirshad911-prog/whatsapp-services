import { subscribe, publish, CHANNELS } from './redis.js';
import { sendMessage, getConnectionState } from './baileys.js';
import { broadcast } from './wsServer.js';
import { logger } from './logger.js';

export function startCRMBridge() {
  subscribe(CHANNELS.MESSAGE_RECEIVED, async (payload) => {
    const { data } = payload;
    if (!data) return;
    broadcast('crm_message', data);
    await publish('crm.message_received', data);
  });
  subscribe('crm.send_message', async (payload) => {
    const { data } = payload;
    if (!data?.to || !data?.body) return;
    if (getConnectionState() !== 'connected') {
      await publish('crm.message_failed', { ...data, reason: 'not_connected' });
      return;
    }
    const result = await sendMessage(data.to, data.body);
    broadcast('crm_message_sent', { ...data, messageId: result.messageId });
    await publish('crm.message_sent', { ...data, messageId: result.messageId });
  });
  logger.info('[CRMBridge] Bridge active');
}
