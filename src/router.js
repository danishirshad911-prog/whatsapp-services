/* global process */
import { Router } from 'express';
import { getConnectionState, getPhoneNumber, getDeviceInfo, sendMessage, disconnect, forceReconnect } from './baileys.js';
import { isRedisConnected } from './redis.js';
import { logger } from './logger.js';
import { checkOllamaHealth, pullModel } from './ollama.js';
import { processDocument } from './documentProcessor.js';
import { deleteDocumentChunks } from './ragEngine.js';
import { runCampaign, pauseCampaign, resumeCampaign, cancelCampaign, buildAudience, isCampaignRunning } from './campaignEngine.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'whatsapp-service', ts: Date.now(), uptime: process.uptime(), redis: isRedisConnected() ? 'connected' : 'disconnected' }));
router.get('/db-health', (_req, res) => res.json({ status: 'ok' }));
router.get('/redis-health', (_req, res) => { const c = isRedisConnected(); res.status(c ? 200 : 503).json({ status: c ? 'ok' : 'degraded' }); });
router.get('/status', (_req, res) => res.json({ status: getConnectionState(), connected: getConnectionState() === 'connected', phone: getPhoneNumber(), device: getDeviceInfo(), ts: Date.now() }));

router.get('/qr', async (_req, res) => {
  if (getConnectionState() === 'connected') return res.json({ status: 'already_connected', qr: null });
  res.json({ status: 'connecting', message: 'QR will arrive via WebSocket' });
  forceReconnect().catch(err => logger.error(`[Router] ${err.message}`));
});

router.post('/send-message', async (req, res) => {
  const { to, body } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: '"to" and "body" required' });
  if (getConnectionState() !== 'connected') return res.status(503).json({ error: 'WhatsApp not connected' });
  const result = await sendMessage(to, body);
  res.json({ success: true, ...result });
});

router.post('/disconnect', async (_req, res) => { await disconnect(); res.json({ success: true }); });
router.post('/reconnect', async (_req, res) => { res.json({ success: true }); forceReconnect().catch(() => {}); });

router.get('/ai/health', async (_req, res) => { const h = await checkOllamaHealth(); res.status(h.healthy ? 200 : 503).json(h); });
router.post('/ai/pull-model', async (req, res) => { const { model } = req.body || {}; if (!model) return res.status(400).json({ error: '"model" required' }); res.json({ success: true }); pullModel(model).catch(() => {}); });

router.post('/campaigns/start', async (req, res) => { const { campaign_id } = req.body || {}; if (!campaign_id) return res.status(400).json({ error: '"campaign_id" required' }); if (isCampaignRunning(campaign_id)) return res.status(409).json({ error: 'Already running' }); res.json({ success: true }); runCampaign(campaign_id).catch(() => {}); });
router.post('/campaigns/pause', async (req, res) => { const { campaign_id } = req.body || {}; if (campaign_id) pauseCampaign(campaign_id); res.json({ success: true }); });
router.post('/campaigns/resume', async (req, res) => { const { campaign_id } = req.body || {}; if (campaign_id) resumeCampaign(campaign_id); res.json({ success: true }); });
router.post('/campaigns/cancel', async (req, res) => { const { campaign_id } = req.body || {}; if (campaign_id) cancelCampaign(campaign_id); res.json({ success: true }); });
router.post('/campaigns/preview-audience', async (req, res) => { const { campaign } = req.body || {}; if (!campaign) return res.status(400).json({ error: '"campaign" required' }); const contacts = await buildAudience(campaign); res.json({ count: contacts.length, contacts: contacts.slice(0, 10) }); });

router.post('/knowledge/index', async (req, res) => { const { document_id } = req.body || {}; if (!document_id) return res.status(400).json({ error: '"document_id" required' }); res.json({ success: true }); processDocument(document_id).catch(() => {}); });
router.post('/knowledge/reindex', async (req, res) => { const { document_id } = req.body || {}; if (!document_id) return res.status(400).json({ error: '"document_id" required' }); res.json({ success: true }); processDocument(document_id).catch(() => {}); });
router.delete('/knowledge/document/:id', async (req, res) => { const count = await deleteDocumentChunks(req.params.id); res.json({ success: true, deleted_chunks: count }); });

export default router;
