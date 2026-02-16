const express = require('express');
const fs = require('fs/promises');
const multer = require('multer');
const {
  listSessions,
  createSession,
  assertSessionExists,
  deleteSession,
} = require('../services/sessionService');
const {
  createPdfRecord,
  updatePdfStorage,
  listPdfsBySession,
  assertPdfExists,
  deletePdfRecord,
  getPdfReadinessBySession,
} = require('../services/pdfRecordService');
const {
  uploadsRoot,
  sanitizeFilename,
  saveUploadedPdfById,
  removeStoredPdf,
} = require('../services/uploadService');
const { addJob, getJob, getQueueState } = require('../services/jobQueue');
const { runChatQuery, shouldRunAsyncChat } = require('../services/ragService');
const { addConversation, listSessionHistory, clearSessionHistory } = require('../services/chatHistoryService');
const { getMetrics, recordQuery } = require('../services/metricsService');
const { ok, fail } = require('./helpers');
const asyncHandler = require('../utils/asyncHandler');
const { createHttpError } = require('../utils/errors');
const { logInfo, logError } = require('../utils/logger');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES) || 50 * 1024 * 1024,
  },
});

function normalizeMulterError(error) {
  if (error?.name === 'MulterError') {
    const err = new Error(
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds configured size limit.'
        : error.message || 'Upload failed.'
    );
    err.statusCode = 400;
    throw err;
  }
  if (error) {
    throw error;
  }
}

function parsePositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createHttpError(400, `${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function validateHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string')
    .map((entry) => ({ role: entry.role, text: entry.text.trim() }))
    .filter((entry) => entry.text.length > 0);
}

function normalizeOptionalTitle(title, fallback) {
  const normalized = String(title || '').trim();
  if (normalized) {
    return normalized;
  }
  return sanitizeFilename(fallback || 'uploaded.pdf').replace(/\.pdf$/i, '');
}

router.get('/health', (req, res) => ok(res, { status: 'ok', service: 'Document-analyzer-rag Backend' }));
router.get('/ping', (req, res) => ok(res, { pong: true }));

router.get('/sessions', (req, res) => ok(res, listSessions()));

router.post('/sessions', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) {
    throw createHttpError(400, 'title is required and must be a string.');
  }

  const session = createSession(title);
  return ok(res, session);
});

router.get('/sessions/:sessionId', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId);
  const pdfs = listPdfsBySession(sessionId);
  return ok(res, { ...session, pdfs });
});

router.delete('/sessions/:sessionId', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const result = deleteSession(sessionId);
  return ok(res, result);
});

router.post('/sessions/:sessionId/pdfs', (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    try {
      normalizeMulterError(uploadErr);
      const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
      assertSessionExists(sessionId);

      if (!req.file) {
        throw createHttpError(400, 'file is required as multipart form-data.');
      }

      logInfo('UPLOAD_START', {
        route: '/api/v1/sessions/:sessionId/pdfs',
        sessionId,
        originalName: req.file.originalname,
        fileSize: req.file.size,
      });

      const pdf = createPdfRecord({
        sessionId,
        title: normalizeOptionalTitle(req.body.title, req.file.originalname),
        filename: 'pending.pdf',
        storagePath: '',
        type: 'pdf',
      });

      try {
        const { filename, storagePath } = await saveUploadedPdfById({
          sessionId,
          pdfId: pdf.id,
          file: req.file,
        });

        updatePdfStorage(pdf.id, { filename, storagePath });
      } catch (error) {
        logError('ERROR_UPLOAD', error, {
          route: '/api/v1/sessions/:sessionId/pdfs',
          sessionId,
        });
        deletePdfRecord(pdf.id);
        throw error;
      }

      addJob({
        type: 'indexPdf',
        pdfId: pdf.id,
        maxRetries: 3,
      });

      return ok(res, {
        pdfId: pdf.id,
        sessionId,
        title: pdf.title,
        status: 'processing',
      }, 202);
    } catch (error) {
      return next(error);
    }
  });
});

router.get('/pdfs/:pdfId', (req, res) => {
  const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
  const pdf = assertPdfExists(pdfId);
  return ok(res, pdf);
});

router.delete('/pdfs/:pdfId', asyncHandler(async (req, res) => {
  const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
  const removeFile = String(req.query.removeFile || 'false').toLowerCase() === 'true';

  const pdf = assertPdfExists(pdfId);
  if (removeFile) {
    try {
      await removeStoredPdf(pdf.path);
    } catch (error) {
      logError('ERROR_UPLOAD', error, {
        route: '/api/v1/pdfs/:pdfId',
        pdfId,
      });
    }
  }

  const result = deletePdfRecord(pdfId);
  return ok(res, result);
}));

router.get('/sessions/:sessionId/pdfs', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  return ok(res, listPdfsBySession(sessionId));
});

router.post('/sessions/:sessionId/chat', asyncHandler(async (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId);
  const message = String(req.body?.message || '').trim();
  const { history } = req.body;

  if (!message) {
    throw createHttpError(400, 'message is required and must be a string.');
  }

  const normalizedHistory = validateHistory(history);
  const readiness = getPdfReadinessBySession(sessionId);
  if (readiness.uploaded === 0 || readiness.indexed === 0 || readiness.processing > 0 || readiness.failed > 0) {
    return fail(res, 'PDF_NOT_READY', 400);
  }

  logInfo('CHAT_REQUEST', {
    route: '/api/v1/sessions/:sessionId/chat',
    sessionId,
    messageLength: message.length,
  });

  if (shouldRunAsyncChat({ sessionId, history: normalizedHistory })) {
    const job = addJob({
      type: 'chatQuery',
      sessionId,
      message,
      history: normalizedHistory,
      maxRetries: 1,
    });

    return ok(res, {
      jobId: job.id,
      sessionId,
      status: 'processing',
    }, 202);
  }

  const startedAt = Date.now();
  const response = await runChatQuery({
    sessionId,
    message,
    history: normalizedHistory,
  });
  const durationMs = Date.now() - startedAt;
  recordQuery({ queryTimeMs: durationMs });
  try {
    addConversation({
      sessionId,
      userText: message,
      assistantText: response.answer,
    });
  } catch (error) {
    logError('ERROR_DB', error, {
      route: '/api/v1/sessions/:sessionId/chat',
      sessionId,
    });
  }

  return ok(res, {
    answer: response.answer,
    sources: response.sources,
    usedChunksCount: response.usedChunksCount,
    sessionTitle: session.title,
  });
}));

router.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    throw createHttpError(400, 'jobId does not exist.');
  }

  return ok(res, {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    result: job.result,
    error: job.error,
    metrics: job.metrics,
  });
});

router.get('/sessions/:sessionId/history', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
  return ok(res, listSessionHistory(sessionId, { limit, offset }));
});

router.delete('/sessions/:sessionId/history', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  return ok(res, clearSessionHistory(sessionId));
});

router.get('/admin/queue', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    throw createHttpError(400, 'Admin queue endpoint is disabled in production.');
  }

  return ok(res, {
    queue: getQueueState(),
    metrics: getMetrics(),
  });
});

router.post('/admin/reset', asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    throw createHttpError(400, 'Admin reset endpoint is disabled in production.');
  }

  await fs.rm(uploadsRoot, { recursive: true, force: true }).catch((error) => {
    logError('ERROR_UPLOAD', error, {
      route: '/api/v1/admin/reset',
    });
  });
  return ok(res, { reset: true });
}));

module.exports = router;
