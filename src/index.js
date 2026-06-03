/* global process */
import http from 'http';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { connectRedis } from './redis.js';
import { attachWS } from './wsServer.js';
import { startSession } from './baileys.js';
import router from './router.js';
import { startCRMBridge } from './crmBridge.js';
import { startCampaignScheduler } from './campaignEngine.js';

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/', router);
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => { logger.error(`[HTTP] ${err.message}`); res.status(500).json({ error: err.message }); });

const httpServer = http.createServer(app);
attachWS(httpServer);

async function boot() {
  logger.info('WA CRM — WhatsApp Microservice v1.0');
  await new Promise((resolve) => httpServer.listen(config.port, () => { logger.info(`[HTTP] Port ${config.port}`); resolve(); }));
  const redisOk = await connectRedis();
  if (!redisOk) logger.warn('[Boot] Redis unavailable');
  startCRMBridge();
  startCampaignScheduler();
  await startSession('default');
  logger.info('[Boot] Service fully started');
}

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
process.on('SIGINT',  () => httpServer.close(() => process.exit(0)));
process.on('unhandledRejection', (r) => logger.error(`Unhandled: ${r}`));
process.on('uncaughtException',  (e) => logger.error(`Uncaught: ${e.message}`));

boot().catch((err) => { logger.error(`Fatal: ${err.message}`); process.exit(1); });
