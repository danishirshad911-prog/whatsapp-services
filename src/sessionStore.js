import fs from 'fs';
import path from 'path';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { logger } from './logger.js';

export class SessionStore {
  constructor(sessionId = 'default') {
    this.sessionId = sessionId;
    this.dir = path.join(config.session.dir, sessionId);
    this._ensureDir();
  }
  _ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
      logger.info(`[SessionStore] Created: ${this.dir}`);
    }
  }
  get(key) {
    const fp = path.join(this.dir, `${key}.json`);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf8'), BufferJSON.reviver); } catch { return null; }
  }
  set(key, value) {
    const fp = path.join(this.dir, `${key}.json`);
    try { fs.writeFileSync(fp, JSON.stringify(value, BufferJSON.replacer, 2), 'utf8'); } catch (err) { logger.error(`[SessionStore] Write failed: ${err.message}`); }
  }
  delete(key) {
    const fp = path.join(this.dir, `${key}.json`);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  clear() {
    if (fs.existsSync(this.dir)) fs.rmSync(this.dir, { recursive: true, force: true });
    this._ensureDir();
  }
  exists() { return fs.existsSync(path.join(this.dir, 'creds.json')); }
}

// ─── CRITICAL FIX: Use Baileys official initAuthCreds() for fresh sessions ───
// The old implementation returned {} which caused:
// TypeError: Cannot read properties of undefined (reading 'public')
// at processHandshake → noiseKey.public was undefined
export function createAuthState(store) {
  // Load saved creds — if none exist, initialize with Baileys defaults
  const savedCreds = store.get('creds');
  const creds = savedCreds ? savedCreds : initAuthCreds();

  // If no saved creds, persist the newly initialized ones immediately
  if (!savedCreds) {
    store.set('creds', creds);
    logger.info('[SessionStore] Fresh credentials initialized with initAuthCreds()');
  }

  const state = {
    creds,
    keys: {
      get: (type, ids) => {
        const data = {};
        for (const id of ids) {
          const key = store.get(`${type}-${id}`);
          if (key) data[id] = key;
        }
        return data;
      },
      set: (data) => {
        for (const [category, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries || {})) {
            if (value) store.set(`${category}-${id}`, value);
            else store.delete(`${category}-${id}`);
          }
        }
      },
    },
  };
  return { state, saveCreds: () => store.set('creds', state.creds) };
}
