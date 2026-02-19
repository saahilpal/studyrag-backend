const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { buildSamplePdfBuffer } = require('./helpers');

test('job endpoint exposes progress, stage and queue position', async () => {
  const session = await request(app)
    .post('/api/v1/sessions')
    .send({ title: `Job Progress ${Date.now()}` });

  assert.equal(session.status, 200);
  const sessionId = session.body.data.id;

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .attach('file', await buildSamplePdfBuffer(), { filename: 'progress.pdf', contentType: 'application/pdf' });

  assert.equal(upload.status, 202);
  assert.equal(typeof upload.body.data.jobId, 'string');
  assert.equal(typeof upload.body.data.progress, 'number');
  assert.equal(typeof upload.body.data.stage, 'string');
  assert.equal(typeof upload.body.data.queuePosition, 'number');

  const jobId = upload.body.data.jobId;
  let terminalState = null;

  for (let i = 0; i < 50; i += 1) {
    const job = await request(app).get(`/api/v1/jobs/${jobId}`);
    assert.equal(job.status, 200);
    assert.equal(job.body.ok, true);

    const payload = job.body.data;
    assert.equal(typeof payload.progress, 'number');
    assert.ok(payload.progress >= 0 && payload.progress <= 100);
    assert.equal(typeof payload.stage, 'string');
    assert.equal(typeof payload.queuePosition, 'number');

    if (payload.status === 'completed' || payload.status === 'failed') {
      terminalState = payload.status;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.ok(terminalState === 'completed' || terminalState === 'failed');
});
