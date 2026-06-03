import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.log.level,
  transport: config.nodeEnv !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
    : undefined,
});
