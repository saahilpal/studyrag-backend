const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

const MAX_PDF_CACHE_ENTRIES = 64;
const MAX_CHUNK_CACHE_ENTRIES_PER_PDF = 200;
const embeddingCacheByPdf = new Map();

const insertChunkStmt = db.prepare(`
  INSERT OR REPLACE INTO chunks (id, sessionId, pdfId, chunkKey, text, embedding, embeddingVectorLength, createdAt)
  VALUES (@id, @sessionId, @pdfId, @chunkKey, @text, @embedding, @embeddingVectorLength, @createdAt)
`);

const selectChunkPageBySessionStmt = db.prepare(`
  SELECT id, pdfId, text, embedding, embeddingVectorLength
  FROM chunks
  WHERE sessionId = ? AND embeddingVectorLength = ?
  ORDER BY id ASC
  LIMIT ? OFFSET ?
`);

const countChunksBySessionStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM chunks
  WHERE sessionId = ?
`);

const deleteChunksByPdfStmt = db.prepare(`
  DELETE FROM chunks
  WHERE pdfId = ?
`);

const selectRecentTextsBySessionStmt = db.prepare(`
  SELECT text
  FROM chunks
  WHERE sessionId = ?
  ORDER BY createdAt DESC
  LIMIT ?
`);

const deleteOrphanChunksStmt = db.prepare(`
  DELETE FROM chunks
  WHERE NOT EXISTS (
      SELECT 1 FROM sessions s WHERE s.id = chunks.sessionId
    )
    OR (
      chunks.pdfId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pdfs p WHERE p.id = chunks.pdfId)
    )
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

function addChunks({ sessionId, pdfId, items, replacePdfChunks = false }) {
  const now = new Date().toISOString();

  const insertMany = db.transaction((rows) => {
    if (replacePdfChunks && pdfId) {
      invalidatePdfCache(pdfId);
      deleteChunksByPdfStmt.run(pdfId);
    }

    let index = 0;
    for (const row of rows) {
      const embedding = Array.isArray(row.embedding) ? row.embedding : [];
      insertChunkStmt.run({
        id: uuidv4(),
        sessionId,
        pdfId,
        chunkKey: String(row.chunkKey || `${pdfId || 'pdf'}:${index}`),
        text: row.text,
        embedding: JSON.stringify(embedding),
        embeddingVectorLength: embedding.length,
        createdAt: now,
      });
      index += 1;
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

function mergeTopK(existing, next, topK) {
  return [...existing, ...next]
    .filter((item) => item && Number.isFinite(item.score) && item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

async function similaritySearch({
  sessionId,
  queryEmbedding,
  topK = 5,
  pageSize = Number(process.env.RAG_CANDIDATE_PAGE_SIZE) || 400,
  onProgress,
}) {
  const normalizedTopK = Math.max(1, Math.min(5, Number(topK) || 5));
  const normalizedPageSize = Math.max(50, Math.min(1000, Number(pageSize) || 400));
  const totalRows = countChunksBySessionStmt.get(sessionId).count;
  const queryVectorLength = Array.isArray(queryEmbedding) ? queryEmbedding.length : 0;

  if (!queryVectorLength || totalRows === 0) {
    if (typeof onProgress === 'function') {
      onProgress({ processed: 0, total: totalRows });
    }
    return [];
  }

  let offset = 0;
  let bestMatches = [];

  while (offset < totalRows) {
    const rows = selectChunkPageBySessionStmt.all(
      sessionId,
      queryVectorLength,
      normalizedPageSize,
      offset
    );
    if (rows.length === 0) {
      break;
    }

    const scoredRows = rows
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
      .filter((item) => item && Number.isFinite(item.score) && item.score >= 0);

    bestMatches = mergeTopK(bestMatches, scoredRows, normalizedTopK);
    offset += rows.length;

    if (typeof onProgress === 'function') {
      onProgress({
        processed: Math.min(offset, totalRows),
        total: totalRows,
      });
    }

    // Yield between pages to keep the event loop responsive on large corpora.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  return bestMatches.sort((a, b) => b.score - a.score).slice(0, normalizedTopK);
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

function cleanupOrphanChunks() {
  const result = deleteOrphanChunksStmt.run();
  if ((Number(result.changes) || 0) > 0) {
    embeddingCacheByPdf.clear();
  }
  return Number(result.changes) || 0;
}

module.exports = {
  addChunks,
  similaritySearch,
  getChunkCountBySession,
  getRecentContextTextsBySession,
  invalidatePdfCache,
  cleanupOrphanChunks,
  cosineSimilarity,
};
