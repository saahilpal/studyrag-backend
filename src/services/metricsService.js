const metrics = {
  indexing: {
    totalRuns: 0,
    totalTimeMs: 0,
    totalEmbeddingTimeMs: 0,
  },
  query: {
    totalRuns: 0,
    totalTimeMs: 0,
  },
};

function recordIndexing({ indexingTimeMs = 0, embeddingTimeMs = 0 }) {
  metrics.indexing.totalRuns += 1;
  metrics.indexing.totalTimeMs += indexingTimeMs;
  metrics.indexing.totalEmbeddingTimeMs += embeddingTimeMs;
}

function recordQuery({ queryTimeMs = 0 }) {
  metrics.query.totalRuns += 1;
  metrics.query.totalTimeMs += queryTimeMs;
}

function getMetrics() {
  const avgIndexingTime = metrics.indexing.totalRuns > 0
    ? metrics.indexing.totalTimeMs / metrics.indexing.totalRuns
    : 0;

  const avgEmbeddingTime = metrics.indexing.totalRuns > 0
    ? metrics.indexing.totalEmbeddingTimeMs / metrics.indexing.totalRuns
    : 0;

  const avgQueryTime = metrics.query.totalRuns > 0
    ? metrics.query.totalTimeMs / metrics.query.totalRuns
    : 0;

  return {
    indexingTime: {
      totalRuns: metrics.indexing.totalRuns,
      averageMs: avgIndexingTime,
    },
    embeddingTime: {
      totalRuns: metrics.indexing.totalRuns,
      averageMs: avgEmbeddingTime,
    },
    averageQueryTime: {
      totalRuns: metrics.query.totalRuns,
      averageMs: avgQueryTime,
    },
  };
}

module.exports = {
  recordIndexing,
  recordQuery,
  getMetrics,
};
