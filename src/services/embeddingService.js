let extractorPromise = null;
const { logInfo } = require('../utils/logger');

const DEFAULT_BATCH_SIZE = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE) || 24;
const MIN_BATCH_SIZE = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE_MIN) || 8;
const MAX_BATCH_SIZE = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE_MAX) || 64;

async function getExtractor() {
  if (extractorPromise) {
    return extractorPromise;
  }

  // Keep CommonJS project-wide while loading ESM-only transformers package lazily.
  extractorPromise = (async () => {
    logInfo('INDEX_DONE', { component: 'embeddingService', stage: 'model_load_start' });
    const { pipeline } = await import('@xenova/transformers');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    logInfo('INDEX_DONE', { component: 'embeddingService', stage: 'model_load_done' });
    return extractor;
  })();

  return extractorPromise;
}

function toVectors(outputs) {
  const dims = outputs?.dims || [];
  const values = outputs?.data ? Array.from(outputs.data) : null;

  if (!values || values.length === 0) {
    throw new Error('Local embedding model returned empty vectors.');
  }

  // Expected pooled batch output shape [batch, hidden]
  if (dims.length === 2) {
    const [batchSize, hiddenSize] = dims;
    const vectors = [];
    for (let i = 0; i < batchSize; i += 1) {
      const start = i * hiddenSize;
      const end = start + hiddenSize;
      vectors.push(values.slice(start, end));
    }
    return vectors;
  }

  // If a single vector comes back from a batch of one, normalize shape.
  if (dims.length === 1) {
    return [values];
  }

  throw new Error(`Unexpected embedding tensor shape from local model: ${JSON.stringify(dims)}`);
}

function clampBatchSize(batchSize) {
  const value = Number(batchSize) || DEFAULT_BATCH_SIZE;
  return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, value));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function generateEmbeddings(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const batchSize = clampBatchSize(options.batchSize);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  try {
    const extractor = await getExtractor();

    // Batching significantly improves throughput by reducing pipeline overhead
    // and maximizing ONNX runtime utilization per call.
    const textBatches = chunkArray(texts, batchSize);
    const vectors = [];

    for (let batchIndex = 0; batchIndex < textBatches.length; batchIndex += 1) {
      const batch = textBatches[batchIndex];
      // Memory-safe sequential loop: avoids OOM spikes from parallel embedding calls.
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      const batchVectors = toVectors(output);
      vectors.push(...batchVectors);

      if (onProgress) {
        onProgress({
          batchIndex: batchIndex + 1,
          totalBatches: textBatches.length,
          processed: vectors.length,
          total: texts.length,
          batchSize: batch.length,
        });
      }
    }

    return vectors;
  } catch (error) {
    const err = new Error(`Local embedding generation failed: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }
}

async function generateEmbedding(text, options = {}) {
  if (!text || typeof text !== 'string') {
    throw new Error('Text is required to generate an embedding.');
  }

  const vectors = await generateEmbeddings([text], options);
  if (!vectors[0]) {
    throw new Error('Local embedding model returned no vector.');
  }
  return vectors[0];
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  generateEmbedding,
  generateEmbeddings,
};
