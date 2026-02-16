const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

const MAX_PDF_CACHE_ENTRIES = 64;
const MAX_CHUNK_CACHE_ENTRIES_PER_PDF = 200;
const embeddingCacheByPdf = new Map();

const insertChunkStmt = db.prepare(`
  INSERT INTO chunks (id, sessionId, pdfId, text, embedding, embeddingVectorLength, createdAt)
  VALUES (@id, @sessionId, @pdfId, @text, @embedding, @embeddingVectorLength, @createdAt)
`);

const selectChunksBySessionStmt = db.prepare(`
  SELECT id, pdfId, text, embedding, embeddingVectorLength
  FROM chunks
  WHERE sessionId = ?
  ORDER BY createdAt DESC
  LIMIT ? OFFSET ?
`);

const countChunksBySessionStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM chunks
  WHERE sessionId = ?
`);

const selectRecentTextsBySessionStmt = db.prepare(`
  SELECT text
  FROM chunks
  WHERE sessionId = ?
  ORDER BY createdAt DESC
  LIMIT ?
`);

function setPdfChunkCache(pdfId, chunkId, vector) {
  const normalizedPdfId = String(pdfId || 'unknown');
  let pdfCache = embeddingCacheByPdf.get(normalizedPdfId);

  if (!pdfCache) {
    pdfCache = new Map();
    embeddingCacheByPdf.set(normalizedPdfId, pdfCache);
  } else {
    embeddingCacheByPdf.delete(normalizedPdfId);
    embeddingCacheByPdf.set(normalizedPdfId, pdfCache);
  }

  if (pdfCache.has(chunkId)) {
    pdfCache.delete(chunkId);
  }
  pdfCache.set(chunkId, vector);

  while (pdfCache.size > MAX_CHUNK_CACHE_ENTRIES_PER_PDF) {
    const oldestChunkId = pdfCache.keys().next().value;
    pdfCache.delete(oldestChunkId);
  }

  while (embeddingCacheByPdf.size > MAX_PDF_CACHE_ENTRIES) {
    const oldestPdfId = embeddingCacheByPdf.keys().next().value;
    embeddingCacheByPdf.delete(oldestPdfId);
  }
}

function getCachedVector(pdfId, chunkId) {
  const normalizedPdfId = String(pdfId || 'unknown');
  const pdfCache = embeddingCacheByPdf.get(normalizedPdfId);
  if (!pdfCache || !pdfCache.has(chunkId)) {
    return null;
  }

  const value = pdfCache.get(chunkId);
  pdfCache.delete(chunkId);
  pdfCache.set(chunkId, value);
  embeddingCacheByPdf.delete(normalizedPdfId);
  embeddingCacheByPdf.set(normalizedPdfId, pdfCache);

  return value;
}

function addChunks({ sessionId, pdfId, items }) {
  const now = new Date().toISOString();

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      const embedding = Array.isArray(row.embedding) ? row.embedding : [];
      insertChunkStmt.run({
        id: uuidv4(),
        sessionId,
        pdfId,
        text: row.text,
        embedding: JSON.stringify(embedding),
        embeddingVectorLength: embedding.length,
        createdAt: now,
      });
    }
  });

  insertMany(items);
  return items.length;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return -1;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) {
    return -1;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function parseVectorForChunk(chunk) {
  const cached = getCachedVector(chunk.pdfId, chunk.id);
  if (cached) {
    return cached;
  }

  try {
    const parsed = JSON.parse(chunk.embedding);
    if (Array.isArray(parsed)) {
      setPdfChunkCache(chunk.pdfId, chunk.id, parsed);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function similaritySearch({ sessionId, queryEmbedding, topK = 5, limit = 300, offset = 0 }) {
  const rows = selectChunksBySessionStmt.all(sessionId, limit, offset);
  const normalizedTopK = Math.max(1, Math.min(5, Number(topK) || 5));

  return new Promise((resolve) => {
    setImmediate(() => {
      const result = rows
        .map((row) => {
          const vector = parseVectorForChunk(row);
          if (!vector) {
            return null;
          }

          return {
            chunkId: row.id,
            pdfId: row.pdfId,
            text: row.text,
            score: cosineSimilarity(queryEmbedding, vector),
          };
        })
        .filter((item) => item && Number.isFinite(item.score) && item.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, normalizedTopK);

      resolve(result);
    });
  });
}

function getChunkCountBySession(sessionId) {
  return countChunksBySessionStmt.get(sessionId).count;
}

function getRecentContextTextsBySession(sessionId, limit = 20) {
  return selectRecentTextsBySessionStmt
    .all(sessionId, limit)
    .map((row) => row.text)
    .filter(Boolean);
}

function invalidatePdfCache(pdfId) {
  embeddingCacheByPdf.delete(String(pdfId || 'unknown'));
}

module.exports = {
  addChunks,
  similaritySearch,
  getChunkCountBySession,
  getRecentContextTextsBySession,
  invalidatePdfCache,
  cosineSimilarity,
};
