const path = require('path');
const db = require('../db/database');
const { invalidatePdfCache } = require('./vectorService');

const insertPdfStmt = db.prepare(`
  INSERT INTO pdfs (sessionId, title, filename, path, type, status, indexedChunks, createdAt)
  VALUES (@sessionId, @title, @filename, @path, @type, @status, @indexedChunks, @createdAt)
`);

const getPdfStmt = db.prepare(`
  SELECT id, sessionId, title, filename, path, type, status, indexedChunks, createdAt
  FROM pdfs
  WHERE id = ?
`);

const listPdfsBySessionStmt = db.prepare(`
  SELECT id, sessionId, title, filename, path, type, status, indexedChunks, createdAt
  FROM pdfs
  WHERE sessionId = ?
  ORDER BY id ASC
`);

const updatePdfStatusStmt = db.prepare(`
  UPDATE pdfs
  SET status = @status,
      indexedChunks = @indexedChunks
  WHERE id = @id
`);

const updatePdfStorageStmt = db.prepare(`
  UPDATE pdfs
  SET filename = @filename,
      path = @path
  WHERE id = @id
`);

const countIndexedPdfsBySessionStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM pdfs
  WHERE sessionId = ? AND status = 'indexed' AND indexedChunks > 0
`);

const countPdfsBySessionStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM pdfs
  WHERE sessionId = ?
`);

const countPdfsBySessionAndStatusStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM pdfs
  WHERE sessionId = ? AND status = ?
`);

const deletePdfStmt = db.prepare(`
  DELETE FROM pdfs
  WHERE id = ?
`);

const deleteChunksByPdfStmt = db.prepare(`
  DELETE FROM chunks
  WHERE pdfId = ?
`);

function createPdfRecord({ sessionId, title, filename = '', storagePath = '', type = 'pdf' }) {
  const createdAt = new Date().toISOString();
  const normalizedTitle = title ? title.trim() : path.basename(filename, path.extname(filename));

  const result = insertPdfStmt.run({
    sessionId,
    title: normalizedTitle || filename,
    filename,
    path: storagePath,
    type: type.toLowerCase(),
    status: 'processing',
    indexedChunks: 0,
    createdAt,
  });

  return getPdfById(Number(result.lastInsertRowid));
}

function getPdfById(pdfId) {
  return getPdfStmt.get(pdfId) || null;
}

function listPdfsBySession(sessionId) {
  return listPdfsBySessionStmt.all(sessionId);
}

function updatePdfStorage(pdfId, { filename, storagePath }) {
  updatePdfStorageStmt.run({
    id: pdfId,
    filename,
    path: storagePath,
  });
  return getPdfById(pdfId);
}

function assertPdfExists(pdfId) {
  const pdf = getPdfById(pdfId);
  if (!pdf) {
    const error = new Error('pdfId does not exist.');
    error.statusCode = 400;
    throw error;
  }
  return pdf;
}

function markPdfIndexed(pdfId, indexedChunks) {
  updatePdfStatusStmt.run({ id: pdfId, status: 'indexed', indexedChunks });
}

function markPdfFailed(pdfId) {
  updatePdfStatusStmt.run({ id: pdfId, status: 'failed', indexedChunks: 0 });
}

function deletePdfRecord(pdfId) {
  assertPdfExists(pdfId);
  const remove = db.transaction((id) => {
    invalidatePdfCache(id);
    deleteChunksByPdfStmt.run(id);
    deletePdfStmt.run(id);
  });
  remove(pdfId);
  return { deleted: true, id: pdfId };
}

function getIndexedPdfCountBySession(sessionId) {
  return countIndexedPdfsBySessionStmt.get(sessionId).count;
}

function getPdfReadinessBySession(sessionId) {
  const uploaded = countPdfsBySessionStmt.get(sessionId).count;
  const indexed = getIndexedPdfCountBySession(sessionId);
  const processing = countPdfsBySessionAndStatusStmt.get(sessionId, 'processing').count;
  const failed = countPdfsBySessionAndStatusStmt.get(sessionId, 'failed').count;

  return {
    uploaded,
    indexed,
    processing,
    failed,
  };
}

module.exports = {
  createPdfRecord,
  updatePdfStorage,
  getPdfById,
  listPdfsBySession,
  assertPdfExists,
  markPdfIndexed,
  markPdfFailed,
  deletePdfRecord,
  getIndexedPdfCountBySession,
  getPdfReadinessBySession,
};
