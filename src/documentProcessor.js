/* global process, fetch, Buffer */
import { splitIntoChunks, extractKeywords, storeChunk, deleteDocumentChunks } from './ragEngine.js';
import { publish } from './redis.js';
import { logger } from './logger.js';

const BASE44_API = process.env.BASE44_API_URL || 'https://api.base44.com/api/apps';
const APP_ID = process.env.BASE44_APP_ID || '';
const API_KEY = process.env.BASE44_API_KEY || '';

async function b44(method, entity, query = {}, data = null) {
  if (!APP_ID || !API_KEY) return null;
  const base = `${BASE44_API}/${APP_ID}/entities/${entity}`;
  let url = base;
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` } };
  if (method === 'GET') { const qs = new URLSearchParams(); if (query.filter) qs.set('filter', JSON.stringify(query.filter)); if (query.limit) qs.set('limit', String(query.limit)); url = `${base}?${qs.toString()}`; }
  else { opts.body = JSON.stringify(data || {}); }
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`b44 ${method} ${entity}: ${res.status}`);
  return res.json();
}

async function extractText(fileUrl, fileType) {
  const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  switch (fileType) {
    case 'txt': return buffer.toString('utf-8');
    case 'csv': return buffer.toString('utf-8').split('\n').map(l => l.replace(/,/g, ' | ').trim()).filter(Boolean).join('\n');
    case 'pdf': { const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default; const data = await pdfParse(buffer); return data.text || ''; }
    case 'docx': { const mammoth = (await import('mammoth')).default; const result = await mammoth.extractRawText({ buffer }); return result.value || ''; }
    default: throw new Error(`Unsupported file type: ${fileType}`);
  }
}

export async function processDocument(documentId) {
  const docRes = await b44('GET', `KnowledgeDocument/${documentId}`);
  const doc = docRes?.item || docRes;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  await b44('PUT', 'KnowledgeDocument', {}, { id: documentId, status: 'processing', error: '' }).catch(() => {});
  try {
    const rawText = await extractText(doc.file_url, doc.file_type);
    if (!rawText?.trim()) throw new Error('No text extracted');
    const chunks = splitIntoChunks(rawText, 800, 150);
    await deleteDocumentChunks(documentId);
    for (let i = 0; i < chunks.length; i++) {
      await storeChunk({ documentId, documentTitle: doc.title, content: chunks[i], chunkIndex: i, keywords: extractKeywords(chunks[i]), metadata: { chunk_total: chunks.length } });
    }
    await b44('PUT', 'KnowledgeDocument', {}, { id: documentId, status: 'indexed', chunk_count: chunks.length, char_count: rawText.length, error: '' });
    await publish('embeddings.generated', { document_id: documentId, document_title: doc.title, chunk_count: chunks.length }).catch(() => {});
    return { success: true, chunk_count: chunks.length };
  } catch (err) {
    logger.error(`[DocProcessor] Failed: ${err.message}`);
    await b44('PUT', 'KnowledgeDocument', {}, { id: documentId, status: 'failed', error: err.message }).catch(() => {});
    throw err;
  }
}
