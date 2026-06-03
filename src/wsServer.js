import { WebSocketServer, WebSocket } from 'ws';
import { logger } from './logger.js';

let wss = null;
const clients = new Set();

export function attachWS(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/' });
  wss.on('connection', (ws, req) => {
    logger.info(`[WS] Client connected: ${req.socket.remoteAddress}`);
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'welcome', ts: Date.now() }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
  logger.info('[WS] WebSocket server attached');
  return wss;
}

export function broadcast(type, data = {}) {
  if (!wss) return;
  const payload = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export function clientCount() { return clients.size; }
