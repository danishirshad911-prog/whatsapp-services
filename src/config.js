/* global process */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    retryDelay: 1000,
    maxRetries: 3,
  },
  session: {
    dir: path.resolve(__dirname, '..', process.env.SESSION_DIR || '.wa-sessions'),
    qrTtl: 60000,
  },
  reconnect: {
    maxAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '5', 10),
    delayMs: parseInt(process.env.RECONNECT_DELAY_MS || '3000', 10),
  },
  cors: { origins: ['*'] },
  log: { level: process.env.LOG_LEVEL || 'info' },
  ollama: {
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    defaultModel: process.env.OLLAMA_MODEL || 'llama3',
  },
  base44: {
    apiUrl: process.env.BASE44_API_URL || 'https://api.base44.com/api/apps',
    appId: process.env.BASE44_APP_ID || '',
    apiKey: process.env.BASE44_API_KEY || '',
  },
};
