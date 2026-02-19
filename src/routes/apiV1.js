const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const multer = require('multer');
const { z } = require('zod');
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
  ensureTempUploadDir,
  saveUploadedPdfById,
  removeStoredPdf,
  removeTempUpload,
} = require('../services/uploadService');
const {
  addJob,
  getJob,
  getQueueState,
  getQueuePosition,
} = require('../services/jobQueue');
const { runChatQuery, runChatQueryStream, shouldRunAsyncChat } = require('../services/ragService');
const { addConversation, listSessionHistory, clearSessionHistory } = require('../services/chatHistoryService');
const { getMetrics, recordQuery } = require('../services/metricsService');
const rateLimiter = require('../middleware/rateLimiter');
const validateSchema = require('../middleware/validate');
const { ok, fail } = require('./helpers');
const asyncHandler = require('../utils/asyncHandler');
const { createHttpError, normalizeHttpError } = require('../utils/errors');
const { logInfo, logError } = require('../utils/logger');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      ensureTempUploadDir()
        .then((tempDir) => cb(null, tempDir))
        .catch((error) => cb(error));
    },
    filename(req, file, cb) {
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(16).slice(2, 10);
      cb(null, `${timestamp}_${randomSuffix}_${sanitizeFilename(file.originalname || 'upload.pdf')}`);
    },
  }),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES) || 50 * 1024 * 1024,
  },
});

const createSessionBodySchema = z.object({
  title: z.string().min(1).max(160),
});

const chatBodySchema = z.object({
  message: z.string().min(1).max(10_000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  })).max(100).optional(),
});

const historyQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/)
    .optional(),
});

const strictReadLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 200 });
const writeLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 80 });
const uploadLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 16 });
const chatLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 30 });

function normalizeMulterError(error) {
  if (error?.name === 'MulterError') {
    throw createHttpError(
      400,
      error.code === 'LIMIT_FILE_SIZE' ? 'UPLOAD_TOO_LARGE' : 'UPLOAD_FAILED',
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds configured size limit.'
        : error.message || 'Upload failed.'
    );
  }
  if (error) {
    throw error;
  }
}

function parsePositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createHttpError(400, 'INVALID_PATH_PARAM', `${fieldName} must be a positive integer.`, {
      retryable: false,
    });
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

function shouldStreamChat(req) {
  const queryFlag = String(req.query.stream || '').toLowerCase() === 'true';
  const acceptHeader = String(req.headers.accept || '').toLowerCase();
  return queryFlag || acceptHeader.includes('text/event-stream');
}

function initSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

router.get('/health', strictReadLimiter, (req, res) => {
  const queueState = getQueueState();
  const memoryUsage = process.memoryUsage();
  const cpuLoad = os.loadavg();

  return ok(res, {
    status: 'ok',
    service: 'Document-analyzer-rag Backend',
    uptime: process.uptime(),
    queueSize: queueState.pending + queueState.processing,
    memoryUsage: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
    },
    cpuLoad: {
      oneMinute: cpuLoad[0],
      fiveMinutes: cpuLoad[1],
      fifteenMinutes: cpuLoad[2],
    },
  });
});
router.get('/ping', strictReadLimiter, (req, res) => ok(res, { pong: true }));

router.get('/sessions', strictReadLimiter, (req, res) => ok(res, listSessions()));

router.post('/sessions', writeLimiter, validateSchema(createSessionBodySchema), (req, res) => {
  const title = req.body.title.trim();

  const session = createSession(title);
  return ok(res, session);
});

router.get('/sessions/:sessionId', strictReadLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId);
  const pdfs = listPdfsBySession(sessionId);
  return ok(res, { ...session, pdfs });
});

router.delete('/sessions/:sessionId', writeLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const result = deleteSession(sessionId);
  return ok(res, result);
});

router.post('/sessions/:sessionId/pdfs', uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    let tempFilePath = '';
    try {
      normalizeMulterError(uploadErr);
      const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
      assertSessionExists(sessionId);

      if (!req.file) {
        throw createHttpError(400, 'MISSING_UPLOAD_FILE', 'file is required as multipart form-data.');
      }
      tempFilePath = req.file.path;

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

      const indexJob = addJob({
        type: 'indexPdf',
        pdfId: pdf.id,
        maxRetries: 3,
      });

      return ok(res, {
        pdfId: pdf.id,
        sessionId,
        title: pdf.title,
        status: 'processing',
        jobId: indexJob.id,
        progress: indexJob.progress,
        stage: indexJob.stage,
        queuePosition: getQueuePosition(indexJob.id),
      }, 202);
    } catch (error) {
      await removeTempUpload(tempFilePath).catch((cleanupError) => {
        logError('ERROR_UPLOAD', cleanupError, {
          route: '/api/v1/sessions/:sessionId/pdfs',
          stage: 'cleanupTempUpload',
        });
      });
      return next(error);
    }
  });
});

router.get('/pdfs/:pdfId', strictReadLimiter, (req, res) => {
  const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
  const pdf = assertPdfExists(pdfId);
  return ok(res, pdf);
});

router.delete('/pdfs/:pdfId', writeLimiter, asyncHandler(async (req, res) => {
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

router.get('/sessions/:sessionId/pdfs', strictReadLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  return ok(res, listPdfsBySession(sessionId));
});

router.post('/sessions/:sessionId/chat', chatLimiter, validateSchema(chatBodySchema), asyncHandler(async (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId);
  const message = req.body.message.trim();
  const { history } = req.body;

  const normalizedHistory = validateHistory(history);
  const readiness = getPdfReadinessBySession(sessionId);
  if (readiness.uploaded === 0 || readiness.indexed === 0 || readiness.processing > 0 || readiness.failed > 0) {
    return fail(
      res,
      createHttpError(400, 'PDF_NOT_READY', 'Documents still processing or failed indexing.', {
        retryable: readiness.processing > 0,
      }),
      400
    );
  }

  logInfo('CHAT_REQUEST', {
    route: '/api/v1/sessions/:sessionId/chat',
    sessionId,
    messageLength: message.length,
  });

  if (shouldStreamChat(req)) {
    initSse(res);
    let clientDisconnected = false;
    req.on('aborted', () => {
      clientDisconnected = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    });

    const emitEvent = (event, payload) => {
      if (clientDisconnected || res.writableEnded) {
        return;
      }
      writeSseEvent(res, event, payload);
    };

    emitEvent('ready', {
      ok: true,
      data: {
        sessionId,
        status: 'streaming',
      },
    });

    try {
      const response = await runChatQueryStream({
        sessionId,
        message,
        history: normalizedHistory,
      }, {
        onProgress: ({ stage, progress }) => {
          emitEvent('progress', {
            ok: true,
            data: { stage, progress },
          });
        },
        onToken: (token) => {
          emitEvent('token', {
            ok: true,
            data: { token },
          });
        },
      });

      if (!clientDisconnected) {
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
            stage: 'streamPersistConversation',
          });
        }
      }

      emitEvent('done', {
        ok: true,
        data: {
          answer: response.answer,
          sources: response.sources,
          usedChunksCount: response.usedChunksCount,
          sessionTitle: session.title,
        },
      });
    } catch (error) {
      const normalized = normalizeHttpError(error);
      emitEvent('error', {
        ok: false,
        error: normalized.error,
      });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
    return;
  }

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
      progress: job.progress,
      stage: job.stage,
      queuePosition: getQueuePosition(job.id),
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

router.get('/jobs/:jobId', strictReadLimiter, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    throw createHttpError(400, 'UNKNOWN_JOB_ID', 'jobId does not exist.');
  }

  return ok(res, {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    queuePosition: getQueuePosition(job.id),
    attempts: job.attempts,
    result: job.result,
    error: job.error,
    metrics: job.metrics,
  });
});

router.get('/sessions/:sessionId/history', strictReadLimiter, validateSchema(historyQuerySchema, 'query'), (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
  return ok(res, listSessionHistory(sessionId, { limit, offset }));
});

router.delete('/sessions/:sessionId/history', writeLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  return ok(res, clearSessionHistory(sessionId));
});

router.get('/admin/queue', strictReadLimiter, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    throw createHttpError(400, 'ADMIN_DISABLED', 'Admin queue endpoint is disabled in production.');
  }

  return ok(res, {
    queue: getQueueState(),
    metrics: getMetrics(),
  });
});

router.post('/admin/reset', writeLimiter, asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    throw createHttpError(400, 'ADMIN_DISABLED', 'Admin reset endpoint is disabled in production.');
  }

  await fs.rm(uploadsRoot, { recursive: true, force: true }).catch((error) => {
    logError('ERROR_UPLOAD', error, {
      route: '/api/v1/admin/reset',
    });
  });
  return ok(res, { reset: true });
}));

module.exports = router;
