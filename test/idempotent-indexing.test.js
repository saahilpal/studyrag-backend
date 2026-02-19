const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');
const { createSession, deleteSession } = require('../src/services/sessionService');
const { createPdfRecord } = require('../src/services/pdfRecordService');
const { addChunks } = require('../src/services/vectorService');

const countChunksByPdfStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM chunks
  WHERE pdfId = ?
`);

test('re-indexing same pdf does not duplicate chunks', async () => {
  const session = createSession(`Idempotent Indexing ${Date.now()}`);
  const pdf = createPdfRecord({
    sessionId: session.id,
    title: 'Idempotent PDF',
    filename: 'idempotent.pdf',
    storagePath: '/tmp/idempotent.pdf',
  });

  const initialRows = [
    { text: 'A', embedding: [1, 0], chunkKey: 'chunk-a' },
    { text: 'B', embedding: [0, 1], chunkKey: 'chunk-b' },
    { text: 'C', embedding: [0.5, 0.5], chunkKey: 'chunk-c' },
  ];
  const updatedRows = [
    { text: 'A2', embedding: [1, 0], chunkKey: 'chunk-a' },
    { text: 'B2', embedding: [0, 1], chunkKey: 'chunk-b' },
    { text: 'C2', embedding: [0.5, 0.5], chunkKey: 'chunk-c' },
  ];

  addChunks({
    sessionId: session.id,
    pdfId: pdf.id,
    items: initialRows,
    replacePdfChunks: true,
  });
  const before = countChunksByPdfStmt.get(pdf.id).count;
  assert.equal(before, 3);

  addChunks({
    sessionId: session.id,
    pdfId: pdf.id,
    items: updatedRows,
    replacePdfChunks: true,
  });
  const afterFirstReindex = countChunksByPdfStmt.get(pdf.id).count;

  addChunks({
    sessionId: session.id,
    pdfId: pdf.id,
    items: updatedRows,
    replacePdfChunks: true,
  });
  const afterSecondReindex = countChunksByPdfStmt.get(pdf.id).count;

  assert.equal(afterFirstReindex, 3);
  assert.equal(afterSecondReindex, 3);

  deleteSession(session.id);
});
