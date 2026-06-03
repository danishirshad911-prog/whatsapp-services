/* global process, fetch, Buffer */
import { publish, getRedisClient } from './redis.js';
import { logger } from './logger.js';

const BASE44_API = process.env.BASE44_API_URL || 'https://api.base44.com/api/apps';
const APP_ID = process.env.BASE44_APP_ID || '';
const API_KEY = process.env.BASE44_API_KEY || '';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const EMBED_CACHE_TTL = 300;
const TOP_K = 5;
const SIMILARITY_THRESHOLD = 0.3;

async function b44(method, entity, query = {}, data = null) {
  if (!APP_ID || !API_KEY) return null;
  const base = `${BASE44_API}/${APP_ID}/entities/${entity}`;
  let url = base;
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` } };
  if (method === 'GET') {
    const qs = new URLSearchParams();
    if (query.filter) qs.set('filter', JSON.stringify(query.filter));
    if (query.sort) qs.set('sort', query.sort);
    if (query.limit) qs.set('limit', String(query.limit));
    url = `${base}?${qs.toString()}`;
  } else { opts.body = JSON.stringify(data || {}); }
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`b44 ${method} ${entity}: ${res.status}`);
  return res.json();
}

export async function generateEmbedding(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, prompt: text }), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
  const data = await res.json();
  if (!data.embedding || !Array.isArray(data.embedding)) throw new Error('No embedding array');
  return data.embedding;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function keywordScore(query, chunk) {
  const q = query.toLowerCase();
  const c = (chunk.content_chunk || '').toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return 0;
  return words.filter(w => c.includes(w)).length / words.length;
}

async function getCachedEmbedding(query) {
  try { const client = getRedisClient(); if (!client) return null; const cached = await client.get(`rag:emb:${Buffer.from(query).toString('base64').slice(0, 64)}`); return cached ? JSON.parse(cached) : null; } catch { return null; }
}

async function setCachedEmbedding(query, embedding) {
  try { const client = getRedisClient(); if (!client) return; await client.setEx(`rag:emb:${Buffer.from(query).toString('base64').slice(0, 64)}`, EMBED_CACHE_TTL, JSON.stringify(embedding)); } catch {}
}

export async function storeChunk({ documentId, documentTitle, content, chunkIndex, keywords, metadata }) {
  let embedding = null;
  try { embedding = await generateEmbedding(content); } catch (err) { logger.warn(`[RAG] Embedding failed: ${err.message}`); }
  await b44('POST', 'KnowledgeChunk', {}, { document_id: documentId, document_title: documentTitle, content_chunk: content, chunk_index: chunkIndex, embedding_vector: embedding || [], keywords: keywords || [], metadata: metadata || {} });
}

export async function retrieveRelevantChunks(query, topK = TOP_K) {
  const start = Date.now();
  let queryEmbedding = await getCachedEmbedding(query);
  if (!queryEmbedding) { try { queryEmbedding = await generateEmbedding(query); await setCachedEmbedding(query, queryEmbedding); } catch {} }
  const chunksRes = await b44('GET', 'KnowledgeChunk', { sort: 'chunk_index', limit: 2000 });
  const allChunks = chunksRes?.items || chunksRes || [];
  if (!allChunks.length) return [];
  const scored = allChunks.map(chunk => ({ ...chunk, _score: queryEmbedding && chunk.embedding_vector?.length ? cosineSimilarity(queryEmbedding, chunk.embedding_vector) : keywordScore(query, chunk) }));
  const results = scored.filter(c => c._score >= SIMILARITY_THRESHOLD).sort((a, b) => b._score - a._score).slice(0, topK);
  logger.info(`[RAG] Retrieved ${results.length}/${allChunks.length} chunks in ${Date.now() - start}ms`);
  await publish('knowledge.searched', { query: query.slice(0, 100), results_count: results.length, latency_ms: Date.now() - start }).catch(() => {});
  return results;
}

export function splitIntoChunks(text, chunkSize = 800, overlap = 150) {
  const chunks = [];
  let start = 0;
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  while (start < clean.length) {
    let end = start + chunkSize;
    if (end < clean.length) { const boundary = clean.lastIndexOf('. ', end); if (boundary > start + chunkSize / 2) end = boundary + 1; }
    const chunk = clean.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    start = end - overlap;
    if (start >= clean.length) break;
  }
  return chunks;
}

export function extractKeywords(text) {
  const stop = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','to','of','in','for','on','with','at','by','from','and','or','but','if','that','this','it','they','we','you']);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !stop.has(w)).slice(0, 20);
}

export async function deleteDocumentChunks(documentId) {
  const chunksRes = await b44('GET', 'KnowledgeChunk', { filter: { document_id: documentId }, limit: 1000 });
  const chunks = chunksRes?.items || chunksRes || [];
  await Promise.all(chunks.map(c => b44('DELETE', `KnowledgeChunk/${c.id}`, {}, null).catch(() => {})));
  return chunks.length;
}
