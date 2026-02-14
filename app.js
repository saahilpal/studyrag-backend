require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

require('./db/database');

const apiV1Route = require('./routes/apiV1');
const legacyRoute = require('./routes/legacy');
const rateLimiter = require('./middleware/rateLimiter');
const { ok, fail } = require('./routes/helpers');
const { normalizeHttpError } = require('./utils/errors');
const { logError } = require('./utils/logger');

const app = express();

const allowedOrigins = [
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^http:\/\/10\.0\.2\.2(:\d+)?$/i,
  /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/i,
  /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/i,
  /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+(:\d+)?$/i,
];

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }
  return allowedOrigins.some((rule) => rule.test(origin));
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    const error = new Error('CORS origin not allowed.');
    error.statusCode = 403;
    return callback(error);
  },
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  return ok(res, { message: 'StudyRAG backend running' });
});

app.get('/health', (req, res) => {
  return ok(res, { status: 'ok', service: 'StudyRAG Backend' });
});

// Authentication has been intentionally removed in this phase to support a local-first academic deployment.
// The backend is structured to allow seamless reintroduction of JWT-based authentication in future iterations without architectural changes.
app.use('/api/v1', rateLimiter({ windowMs: 60_000, maxRequests: 100 }), apiV1Route);

// Transitional aliases for one release.
app.use(legacyRoute);

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err?.name === 'MulterError') {
    logError('ERROR_UPLOAD', err, {
      route: req.originalUrl,
      method: req.method,
    });
    return fail(
      res,
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds configured size limit.'
        : 'Upload failed.',
      400
    );
  }

  if (err?.type === 'entity.parse.failed') {
    return fail(res, 'Invalid JSON body.', 400);
  }

  if (err?.type === 'entity.too.large') {
    return fail(res, 'Request payload too large.', 413);
  }

  const isSqliteError = String(err?.code || '').startsWith('SQLITE');
  if (isSqliteError) {
    logError('ERROR_DB', err, {
      route: req.originalUrl,
      method: req.method,
    });
  }

  const normalized = normalizeHttpError(err);
  if (normalized.status === 500 && !isSqliteError) {
    logError('ERROR_DB', err, {
      route: req.originalUrl,
      method: req.method,
      status: normalized.status,
    });
  }
  return fail(res, normalized.message, normalized.status);
});

app.use((req, res) => {
  return fail(res, 'Not found.', 404);
});

module.exports = app;
