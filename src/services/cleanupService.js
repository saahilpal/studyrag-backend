const { cleanupJobs } = require('./jobQueue');
const { cleanupTempUploadsOlderThan } = require('./uploadService');
const { cleanupOrphanChunks } = require('./vectorService');
const { logInfo, logError } = require('../utils/logger');

const DEFAULT_CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || 15 * 60 * 1000;
const DEFAULT_COMPLETED_JOB_TTL_HOURS = Number(process.env.CLEANUP_COMPLETED_JOB_TTL_HOURS) || 24;
const DEFAULT_FAILED_JOB_TTL_HOURS = Number(process.env.CLEANUP_FAILED_JOB_TTL_HOURS) || 72;
const DEFAULT_TEMP_FILE_TTL_HOURS = Number(process.env.CLEANUP_TEMP_FILE_TTL_HOURS) || 6;

let cleanupTimer = null;
let cleanupRunning = false;

function hoursToMs(hours) {
  return Math.max(0, Number(hours) || 0) * 60 * 60 * 1000;
}

async function runCleanupCycle() {
  if (cleanupRunning) {
    return { skipped: true };
  }

  cleanupRunning = true;
  try {
    const jobs = cleanupJobs({
      completedOlderThanMs: hoursToMs(DEFAULT_COMPLETED_JOB_TTL_HOURS),
      failedOlderThanMs: hoursToMs(DEFAULT_FAILED_JOB_TTL_HOURS),
    });
    const removedTempFiles = await cleanupTempUploadsOlderThan(hoursToMs(DEFAULT_TEMP_FILE_TTL_HOURS));
    const removedOrphanChunks = cleanupOrphanChunks();

    const payload = {
      jobsCompletedDeleted: jobs.completedDeleted,
      jobsFailedDeleted: jobs.failedDeleted,
      jobsMemoryDeleted: jobs.memoryDeleted,
      removedTempFiles,
      removedOrphanChunks,
    };
    logInfo('CLEANUP_DONE', payload);
    return payload;
  } catch (error) {
    logError('ERROR_QUEUE', error, {
      service: 'cleanupService',
      stage: 'runCleanupCycle',
    });
    return { failed: true };
  } finally {
    cleanupRunning = false;
  }
}

function startCleanupWorker() {
  if (cleanupTimer) {
    return cleanupTimer;
  }

  runCleanupCycle().catch(() => null);
  cleanupTimer = setInterval(() => {
    runCleanupCycle().catch(() => null);
  }, DEFAULT_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
  return cleanupTimer;
}

module.exports = {
  runCleanupCycle,
  startCleanupWorker,
};
