const PDFDocument = require('pdfkit');
const request = require('supertest');

async function buildSamplePdfBuffer() {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text('Integration Test PDF');
    doc.moveDown();
    doc.fontSize(12).text('This is sample content for semantic indexing and retrieval.');
    doc.end();
  });
}

async function waitForPdfStatus(app, pdfId, expectedStatus, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await request(app).get(`/api/v1/pdfs/${pdfId}`);
    if (response.status === 200 && response.body?.ok && response.body.data?.status === expectedStatus) {
      return response.body.data;
    }
    if (response.status === 200 && response.body?.ok && response.body.data?.status === 'failed') {
      throw new Error(`PDF ${pdfId} failed indexing.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for pdf ${pdfId} status=${expectedStatus}`);
}

module.exports = {
  buildSamplePdfBuffer,
  waitForPdfStatus,
};
