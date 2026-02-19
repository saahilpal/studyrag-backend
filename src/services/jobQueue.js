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
  INSERT INTO job_queue (id, type, payload, status, progress, stage, attempts, maxRetries, result, error, createdAt, updatedAt)
  VALUES (@id, @type, @payload, @status, @progress, @stage, @attempts, @maxRetries, @result, @error, @createdAt, @updatedAt)
`);

const updateJobStmt = db.prepare(`
  UPDATE job_queue
  SET status = @status,
      progress = @progress,
      stage = @stage,
      attempts = @attempts,
      maxRetries = @maxRetries,
      result = @result,
      error = @error,
      updatedAt = @updatedAt
  WHERE id = @id
`);

const selectRecoverableJobsStmt = db.prepare(`
  SELECT id, type, payload, status, progress, stage, attempts, maxRetries, result, error, createdAt, updatedAt
  FROM job_queue
  WHERE status IN ('queued', 'processing')
  ORDER BY createdAt ASC
`);

const selectJobByIdStmt = db.prepare(`
  SELECT id, type, payload, status, progress, stage, attempts, maxRetries, result, error, createdAt, updatedAt
  FROM job_queue
  WHERE id = ?
`);

const deleteCompletedJobsOlderThanStmt = db.prepare(`
  DELETE FROM job_queue
  WHERE status = 'completed' AND updatedAt < ?
`);

const deleteFailedJobsOlderThanStmt = db.prepare(`
  DELETE FROM job_queue
  WHERE status = 'failed' AND updatedAt < ?
`);

function persistJob(job, isNew = false) {
  const payload = {
    id: job.id,
    type: job.type,
    payload: JSON.stringify(job.payload),
    status: job.status,
    progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
    stage: job.stage || null,
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
    progress: Math.max(0, Math.min(100, Number(row.progress) || 0)),
    stage: row.stage || null,
    attempts: Number(row.attempts) || 0,
    maxRetries: Number(row.maxRetries) || 3,
    createdAt: row.createdAt,
    updatedAt: new Date().toISOString(),
    result: parsedResult,
    error: row.error || null,
    metrics: null,
  };
}

function getDefaultStageByType(type) {
  if (type === 'indexPdf') {
    return 'uploading';
  }
  if (type === 'chatQuery') {
    return 'retrieving';
  }
  return null;
}

function updateJobProgress(job, { progress, stage }) {
  const normalizedProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const normalizedStage = stage || job.stage || getDefaultStageByType(job.type);
  const didChange = job.progress !== normalizedProgress || job.stage !== normalizedStage;

  job.progress = normalizedProgress;
  job.stage = normalizedStage;
  if (!didChange) {
    return true;
  }

  job.updatedAt = new Date().toISOString();
  return safePersistJob(job, false, 'setProgress');
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

function getQueuePosition(jobId) {
  const job = getJob(jobId);
  if (!job) {
    return null;
  }
  if (job.status !== 'queued') {
    return 0;
  }

  const queuedIndex = queue.indexOf(jobId);
  if (queuedIndex < 0) {
    return 0;
  }

  const hasProcessingJob = Array.from(jobs.values()).some((candidate) => candidate.status === 'processing');
  return queuedIndex + (hasProcessingJob ? 1 : 0);
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
    progress: 0,
    stage: getDefaultStageByType(payload.type),
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
    const result = await indexPdfById(job.payload.pdfId, {
      onProgress: ({ progress, stage }) => {
        updateJobProgress(job, { progress, stage });
      },
    });
    recordIndexing({
      indexingTimeMs: result.indexingTimeMs || 0,
      embeddingTimeMs: result.embeddingTimeMs || 0,
    });
    updateJobProgress(job, { progress: 100, stage: 'embedding' });
    return {
      ...result,
      indexingTimeMs: result.indexingTimeMs || Date.now() - startedAt,
    };
  }

  if (job.type === 'chatQuery') {
    const response = await runChatQuery(job.payload, {
      onProgress: ({ progress, stage }) => {
        updateJobProgress(job, { progress, stage });
      },
    });
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
    updateJobProgress(job, { progress: 100, stage: 'generating' });
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
      if (job.type === 'indexPdf') {
        job.progress = Math.max(job.progress || 0, 5);
        job.stage = 'parsing';
      } else if (job.type === 'chatQuery') {
        job.progress = Math.max(job.progress || 0, 10);
        job.stage = 'retrieving';
      }
      if (!safePersistJob(job, false, 'setProcessing')) {
        job.status = 'failed';
        job.progress = Math.max(job.progress || 0, 0);
        job.error = 'Failed to persist processing status.';
        job.updatedAt = new Date().toISOString();
        safePersistJob(job, false, 'markFailedAfterSetProcessing');
        continue;
      }

      const startedAt = Date.now();

      try {
        const result = await runJob(job);
        job.status = 'completed';
        job.progress = 100;
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
          job.stage = getDefaultStageByType(job.type);
          job.progress = 0;
          const backoffMs = 250 * Math.pow(2, job.attempts - 1);
          if (safePersistJob(job, false, 'setRetry')) {
            await wait(backoffMs);
            queue.push(job.id);
          } else {
            job.status = 'failed';
            job.progress = Math.max(job.progress || 0, 0);
            job.error = 'Failed to persist retry state.';
            job.updatedAt = new Date().toISOString();
            safePersistJob(job, false, 'markFailedAfterRetryPersistError');
          }
        } else {
          job.status = 'failed';
          job.progress = Math.max(job.progress || 0, 0);
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
    if (!job.stage) {
      job.stage = getDefaultStageByType(job.type);
    }
    if (!Number.isFinite(job.progress)) {
      job.progress = 0;
    }
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

function cleanupJobs({ completedOlderThanMs, failedOlderThanMs }) {
  const completedThreshold = new Date(Date.now() - Math.max(0, Number(completedOlderThanMs) || 0)).toISOString();
  const failedThreshold = new Date(Date.now() - Math.max(0, Number(failedOlderThanMs) || 0)).toISOString();

  const dbCleanupTx = db.transaction((completedTs, failedTs) => {
    const completedResult = deleteCompletedJobsOlderThanStmt.run(completedTs);
    const failedResult = deleteFailedJobsOlderThanStmt.run(failedTs);
    return {
      completedDeleted: Number(completedResult.changes) || 0,
      failedDeleted: Number(failedResult.changes) || 0,
    };
  });

  const dbDeleted = dbCleanupTx(completedThreshold, failedThreshold);

  let memoryDeleted = 0;
  for (const [jobId, job] of jobs.entries()) {
    const updatedAt = Date.parse(job.updatedAt || job.createdAt || 0);
    const shouldDeleteCompleted = job.status === 'completed' && updatedAt < Date.parse(completedThreshold);
    const shouldDeleteFailed = job.status === 'failed' && updatedAt < Date.parse(failedThreshold);
    if (!shouldDeleteCompleted && !shouldDeleteFailed) {
      continue;
    }
    jobs.delete(jobId);
    memoryDeleted += 1;
  }

  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (!jobs.has(queue[i])) {
      queue.splice(i, 1);
    }
  }

  return {
    ...dbDeleted,
    memoryDeleted,
  };
}

recoverJobsFromDatabase();

module.exports = {
  addJob,
  getJob,
  getQueueState,
  getQueuePosition,
  cleanupJobs,
};
