const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { buildSamplePdfBuffer, waitForPdfStatus } = require('./helpers');

test('chat-first integration flow', async () => {
  const createSession = await request(app)
    .post('/api/v1/sessions')
    .send({ title: `Integration Session ${Date.now()}` });

  assert.equal(createSession.status, 200);
  assert.equal(createSession.body.ok, true);

  const sessionId = createSession.body.data.id;
  assert.ok(sessionId > 0);

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .attach('file', await buildSamplePdfBuffer(), { filename: 'integration.pdf', contentType: 'application/pdf' })
    .field('title', 'Integration PDF');

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);

  const pdfId = upload.body.data.pdfId;
  assert.ok(pdfId > 0);

  const indexedPdf = await waitForPdfStatus(app, pdfId, 'indexed');
  assert.ok(indexedPdf.indexedChunks >= 1);

  const chat = await request(app)
    .post(`/api/v1/sessions/${sessionId}/chat`)
    .send({ message: 'Summarize the document.' });

  if (chat.status === 202) {
    const jobId = chat.body.data.jobId;
    let done = false;
    for (let i = 0; i < 40; i += 1) {
      const poll = await request(app).get(`/api/v1/jobs/${jobId}`);
      assert.equal(poll.status, 200);
      const status = poll.body.data.status;
      if (status === 'completed') {
        done = true;
        assert.ok(typeof poll.body.data.result.answer === 'string');
        break;
      }
      if (status === 'failed') {
        throw new Error(`Chat job failed: ${poll.body.data.error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(done, true);
  } else {
    assert.equal(chat.status, 200);
    assert.equal(chat.body.ok, true);
    assert.ok(typeof chat.body.data.answer === 'string');
    assert.ok(Array.isArray(chat.body.data.sources));
  }

  const history = await request(app).get(`/api/v1/sessions/${sessionId}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.ok, true);
  assert.ok(Array.isArray(history.body.data));
  assert.ok(history.body.data.length >= 2);
  history.body.data.forEach((message) => {
    assert.equal(typeof message.id, 'string');
    assert.ok(['user', 'assistant', 'system'].includes(message.role));
    assert.equal(typeof message.text, 'string');
    assert.equal(typeof message.createdAt, 'string');
    assert.ok(message.createdAt.length > 0);
  });
  for (let i = 1; i < history.body.data.length; i += 1) {
    const prev = new Date(history.body.data[i - 1].createdAt).getTime();
    const curr = new Date(history.body.data[i].createdAt).getTime();
    assert.ok(prev <= curr);
  }
});
