const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { buildSamplePdfBuffer, waitForPdfStatus } = require('./helpers');

test('chat streaming emits SSE tokens and persists conversation on completion', async () => {
  const session = await request(app)
    .post('/api/v1/sessions')
    .send({ title: `Streaming ${Date.now()}` });
  assert.equal(session.status, 200);
  const sessionId = session.body.data.id;

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .attach('file', await buildSamplePdfBuffer(), { filename: 'streaming.pdf', contentType: 'application/pdf' });
  assert.equal(upload.status, 202);

  await waitForPdfStatus(app, upload.body.data.pdfId, 'indexed');

  const streamResponse = await request(app)
    .post(`/api/v1/sessions/${sessionId}/chat?stream=true`)
    .set('Accept', 'text/event-stream')
    .send({ message: 'Summarize the document.' });

  assert.equal(streamResponse.status, 200);
  assert.match(String(streamResponse.headers['content-type'] || ''), /text\/event-stream/i);
  assert.ok(streamResponse.text.includes('event: ready'));
  assert.ok(streamResponse.text.includes('event: progress'));
  assert.ok(streamResponse.text.includes('event: token'));
  assert.ok(streamResponse.text.includes('event: done'));

  const history = await request(app).get(`/api/v1/sessions/${sessionId}/history`);
  assert.equal(history.status, 200);
  assert.ok(history.body.data.length >= 2);
});
