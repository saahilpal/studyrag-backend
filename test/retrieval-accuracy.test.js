const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession, deleteSession } = require('../src/services/sessionService');
const { addChunks, similaritySearch } = require('../src/services/vectorService');

test('similarity search scans full corpus beyond first page', async () => {
  const session = createSession(`Retrieval Accuracy ${Date.now()}`);

  const items = [];
  for (let i = 0; i < 360; i += 1) {
    items.push({
      text: `filler chunk ${i}`,
      embedding: [0, 1],
      chunkKey: `chunk-${i}`,
    });
  }
  // Place the highest-scoring chunk deep into the corpus.
  items[359] = {
    text: 'needle chunk',
    embedding: [1, 0],
    chunkKey: 'chunk-needle',
  };

  addChunks({
    sessionId: session.id,
    pdfId: null,
    items,
    replacePdfChunks: false,
  });

  const result = await similaritySearch({
    sessionId: session.id,
    queryEmbedding: [1, 0],
    topK: 1,
    pageSize: 100,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'needle chunk');

  deleteSession(session.id);
});
