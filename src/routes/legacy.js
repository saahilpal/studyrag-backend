const path = require('path');
const express = require('express');
const {
  listSessions,
  createSession,
  assertSessionExists,
  deleteSession,
} = require('../services/sessionService');
const {
  createPdfRecord,
  listPdfsBySession,
  assertPdfExists,
  deletePdfRecord,
} = require('../services/pdfRecordService');
const { uploadsRoot, isPathWithinUploadsRoot } = require('../services/uploadService');
const { addJob } = require('../services/jobQueue');
const { runChatQuery } = require('../services/ragService');
const { addConversation } = require('../services/chatHistoryService');
const { ok, setDeprecationHeaders } = require('./helpers');
const asyncHandler = require('../utils/asyncHandler');
const { createHttpError } = require('../utils/errors');
const { logInfo, logError } = require('../utils/logger');

const router = express.Router();

function parseId(value, fieldName) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw createHttpError(400, `${fieldName} must be a positive integer.`);
  }
  return id;
}

router.get('/subjects', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions');
  const sessions = listSessions().map((session) => ({ id: session.id, name: session.title }));
  return ok(res, sessions);
});

router.post('/subjects', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions');
  const name = String(req.body?.name || '').trim();
  if (!name) {
    throw createHttpError(400, 'name is required and must be a string.');
  }

  const created = createSession(name);
  return ok(res, { id: created.id, name: created.title });
});

router.delete('/subjects/:id', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId');
  const sessionId = parseId(req.params.id, 'id');
  return ok(res, deleteSession(sessionId));
});

router.get('/subjects/:subjectId/documents', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId/pdfs');
  const sessionId = parseId(req.params.subjectId, 'subjectId');
  assertSessionExists(sessionId);
  const docs = listPdfsBySession(sessionId).map((pdf) => ({
    id: pdf.id,
    title: pdf.title,
    type: pdf.type,
  }));
  return ok(res, docs);
});

router.post('/documents', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId/pdfs');

  const sessionId = parseId(req.body.subjectId, 'subjectId');
  assertSessionExists(sessionId);

  const title = String(req.body.title || '').trim();
  const type = String(req.body.type || '').toLowerCase();
  const relativePath = String(req.body.path || '').trim();

  if (!title || !type || !relativePath) {
    throw createHttpError(400, 'subjectId, title, type, and path are required.');
  }

  if (path.isAbsolute(relativePath)) {
    throw createHttpError(400, 'Legacy path must be relative under data/uploads.');
  }

  const resolved = path.resolve(uploadsRoot, relativePath);
  const relativeToRoot = path.relative(uploadsRoot, resolved);
  if (
    relativePath.includes('\0') ||
    relativeToRoot.startsWith('..') ||
    path.isAbsolute(relativeToRoot) ||
    !isPathWithinUploadsRoot(resolved)
  ) {
    throw createHttpError(400, 'Legacy path is outside allowed uploads directory.');
  }
  if (path.extname(resolved).toLowerCase() !== '.pdf') {
    throw createHttpError(400, 'Legacy path must point to a PDF file.');
  }

  const filename = path.basename(resolved);
  const pdf = createPdfRecord({
    sessionId,
    title,
    filename,
    storagePath: resolved,
    type,
  });

  addJob({
    type: 'indexPdf',
    pdfId: pdf.id,
    maxRetries: 1,
  });

  return ok(res, {
    id: pdf.id,
    subjectId: pdf.sessionId,
    title: pdf.title,
    type: pdf.type,
    path: pdf.path,
    status: pdf.status,
  });
});

router.delete('/documents/:id', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/pdfs/:pdfId');
  const pdfId = parseId(req.params.id, 'id');
  assertPdfExists(pdfId);
  deletePdfRecord(pdfId);
  return ok(res, { deleted: true, id: pdfId });
});

router.post('/rag/query', asyncHandler(async (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId/chat');
  const sessionId = parseId(req.body.subjectId, 'subjectId');
  assertSessionExists(sessionId);

  const question = String(req.body.question || '').trim();
  if (!question) {
    throw createHttpError(400, 'question is required.');
  }
  logInfo('CHAT_REQUEST', { route: 'legacy/rag/query', sessionId, messageLength: question.length });

  const response = await runChatQuery({
    sessionId,
    message: question,
    history: Array.isArray(req.body.history) ? req.body.history : [],
  });

  try {
    addConversation({
      sessionId,
      userText: question,
      assistantText: response.answer,
    });
  } catch (error) {
    logError('ERROR_DB', error, {
      route: 'legacy/rag/query',
      sessionId,
    });
  }

  return ok(res, { answer: response.answer });
}));

module.exports = router;
