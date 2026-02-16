const db = require('../db/database');
const { indexPdfById } = require('./indexingService');
const { runChatQuery } = require('./ragService');
const { addConversation } = require('./chatHistoryService');
const { recordIndexing, recordQuery } = require('./metricsService');
const { logError } = require('../utils/logger');

const queue = [];
const jobs = new Map();
let running = false;
let sequence = 1;

const insertJobStmt = db.prepare(`
  INSERT INTO job_queue (id, type, payload, status, attempts, maxRetries, result, error, createdAt, updatedAt)
  VALUES (@id, @type, @payload, @status, @attempts, @maxRetries, @result, @error, @createdAt, @updatedAt)
`);

const updateJobStmt = db.prepare(`
  UPDATE job_queue
  SET status = @status,
      attempts = @attempts,
      maxRetries = @maxRetries,
      result = @result,
      error = @error,
      updatedAt = @updatedAt
  WHERE id = @id
`);

const selectRecoverableJobsStmt = db.prepare(`
  SELECT id, type, payload, status, attempts, maxRetries, result, error, createdAt, updatedAt
  FROM job_queue
  WHERE status IN ('queued', 'processing')
  ORDER BY createdAt ASC
`);

const selectJobByIdStmt = db.prepare(`
  SELECT id, type, payload, status, attempts, maxRetries, result, error, createdAt, updatedAt
  FROM job_queue
  WHERE id = ?
`);

function persistJob(job, isNew = false) {
  const payload = {
    id: job.id,
    type: job.type,
    payload: JSON.stringify(job.payload),
    status: job.status,
    attempts: job.attempts,
    maxRetries: job.maxRetries,
    result: job.result ? JSON.stringify(job.result) : null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  if (isNew) {
    insertJobStmt.run(payload);
  } else {
    updateJobStmt.run(payload);
  }
}

function safePersistJob(job, isNew = false, stage = 'updateJob') {
  try {
    persistJob(job, isNew);
    return true;
  } catch (error) {
    logError('ERROR_DB', error, {
      service: 'jobQueue',
      stage,
      jobId: job?.id,
      type: job?.type,
    });
    return false;
  }
}

function hydrateJobFromRow(row) {
  let parsedPayload = {};
  let parsedResult = null;
  try {
    parsedPayload = JSON.parse(row.payload || '{}');
  } catch {
    parsedPayload = {};
  }
  try {
    parsedResult = row.result ? JSON.parse(row.result) : null;
  } catch {
    parsedResult = null;
  }

  return {
    id: row.id,
    type: row.type,
    payload: parsedPayload,
    status: row.status === 'processing' ? 'queued' : row.status,
    attempts: Number(row.attempts) || 0,
    maxRetries: Number(row.maxRetries) || 3,
    createdAt: row.createdAt,
    updatedAt: new Date().toISOString(),
    result: parsedResult,
    error: row.error || null,
    metrics: null,
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createJobId() {
  const id = `job_${Date.now()}_${sequence}`;
  sequence += 1;
  return id;
}

function getJob(jobId) {
  if (jobs.has(jobId)) {
    return jobs.get(jobId);
  }

  const row = selectJobByIdStmt.get(jobId);
  if (!row) {
    return null;
  }

  const hydrated = hydrateJobFromRow(row);
  hydrated.status = row.status;
  hydrated.updatedAt = row.updatedAt;
  return hydrated;
}

function getQueueState() {
  const pending = queue.length;
  const processing = Array.from(jobs.values()).filter((job) => job.status === 'processing').length;
  const completed = Array.from(jobs.values()).filter((job) => job.status === 'completed').length;
  const failed = Array.from(jobs.values()).filter((job) => job.status === 'failed').length;

  return {
    pending,
    processing,
    completed,
    failed,
    total: jobs.size,
  };
}

function addJob(payload) {
  const jobId = createJobId();
  const normalizedMaxRetries = Number.isInteger(payload.maxRetries) && payload.maxRetries >= 0
    ? payload.maxRetries
    : 3;
  const job = {
    id: jobId,
    type: payload.type,
    payload,
    status: 'queued',
    attempts: 0,
    maxRetries: normalizedMaxRetries,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
    metrics: null,
  };

  jobs.set(jobId, job);
  if (!safePersistJob(job, true, 'addJobInsert')) {
    jobs.delete(jobId);
    const error = new Error('Failed to enqueue background job.');
    error.statusCode = 500;
    throw error;
  }
  queue.push(jobId);
  processQueue().catch((error) => {
    logError('ERROR_QUEUE', error, {
      service: 'jobQueue',
      stage: 'addJobProcessQueue',
    });
  });

  return job;
}

async function runJob(job) {
  const startedAt = Date.now();

  if (job.type === 'indexPdf') {
    const result = await indexPdfById(job.payload.pdfId);
    recordIndexing({
      indexingTimeMs: result.indexingTimeMs || 0,
      embeddingTimeMs: result.embeddingTimeMs || 0,
    });
    return {
      ...result,
      indexingTimeMs: result.indexingTimeMs || Date.now() - startedAt,
    };
  }

  if (job.type === 'chatQuery') {
    const response = await runChatQuery(job.payload);
    recordQuery({ queryTimeMs: Date.now() - startedAt });
    try {
      addConversation({
        sessionId: job.payload.sessionId,
        userText: job.payload.message,
        assistantText: response.answer,
      });
    } catch (error) {
      logError('ERROR_DB', error, {
        service: 'jobQueue',
        stage: 'persistChatHistory',
        sessionId: job.payload.sessionId,
      });
    }
    return response;
  }

  throw new Error(`Unsupported job type: ${job.type}`);
}

async function processQueue() {
  if (running) {
    return;
  }
  running = true;

  try {
    while (queue.length > 0) {
      const jobId = queue.shift();
      const job = jobs.get(jobId);
      if (!job) {
        continue;
      }

      job.status = 'processing';
      job.updatedAt = new Date().toISOString();
      job.attempts += 1;
      if (!safePersistJob(job, false, 'setProcessing')) {
        job.status = 'failed';
        job.error = 'Failed to persist processing status.';
        job.updatedAt = new Date().toISOString();
        safePersistJob(job, false, 'markFailedAfterSetProcessing');
        continue;
      }

      const startedAt = Date.now();

      try {
        const result = await runJob(job);
        job.status = 'completed';
        job.result = result;
        job.metrics = {
          durationMs: Date.now() - startedAt,
        };
        job.updatedAt = new Date().toISOString();
        safePersistJob(job, false, 'setCompleted');
      } catch (error) {
        job.error = error.message;
        job.updatedAt = new Date().toISOString();

        if (job.attempts <= job.maxRetries) {
          job.status = 'queued';
          const backoffMs = 250 * Math.pow(2, job.attempts - 1);
          if (safePersistJob(job, false, 'setRetry')) {
            await wait(backoffMs);
            queue.push(job.id);
          } else {
            job.status = 'failed';
            job.error = 'Failed to persist retry state.';
            job.updatedAt = new Date().toISOString();
            safePersistJob(job, false, 'markFailedAfterRetryPersistError');
          }
        } else {
          job.status = 'failed';
          safePersistJob(job, false, 'setFailed');
          logError('ERROR_QUEUE', error, {
            service: 'jobQueue',
            stage: 'runJob',
            jobId: job.id,
            type: job.type,
            attempts: job.attempts,
          });
        }
      }
    }
  } catch (error) {
    logError('ERROR_QUEUE', error, {
      service: 'jobQueue',
      stage: 'processQueueLoop',
    });
  } finally {
    running = false;

    if (queue.length > 0) {
      setImmediate(() => {
        processQueue().catch((error) => {
          logError('ERROR_QUEUE', error, {
            service: 'jobQueue',
            stage: 'processQueueDrain',
          });
        });
      });
    }
  }
}

function recoverJobsFromDatabase() {
  let recoverable = [];
  try {
    recoverable = selectRecoverableJobsStmt.all();
  } catch (error) {
    logError('ERROR_DB', error, {
      service: 'jobQueue',
      stage: 'recoverSelect',
    });
    return;
  }

  for (const row of recoverable) {
    const job = hydrateJobFromRow(row);
    jobs.set(job.id, job);
    queue.push(job.id);
    safePersistJob(job, false, 'recoverUpdateQueued');
  }

  if (recoverable.length > 0) {
    processQueue().catch((error) => {
      logError('ERROR_QUEUE', error, {
        service: 'jobQueue',
        stage: 'recoverProcessQueue',
      });
    });
  }
}

recoverJobsFromDatabase();

module.exports = {
  addJob,
  getJob,
  getQueueState,
};
