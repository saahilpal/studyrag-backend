const fs = require('fs/promises');
const { extractTextFromPdfBuffer } = require('./pdfService');
const { chunkText } = require('./chunkService');
const { generateEmbeddings } = require('./embeddingService');
const { addChunks } = require('./vectorService');
const { getPdfById, markPdfIndexed, markPdfFailed } = require('./pdfRecordService');
const { logInfo, logError } = require('../utils/logger');

const TOKEN_TO_CHAR_RATIO = Number(process.env.RAG_TOKEN_TO_CHAR_RATIO) || 4;
const DEFAULT_CHUNK_TOKENS = Number(process.env.RAG_CHUNK_TOKENS) || 1000;
const DEFAULT_OVERLAP_TOKENS = Number(process.env.RAG_CHUNK_OVERLAP_TOKENS) || 200;
const DEFAULT_BATCH_SIZE = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE) || 24;

function getIndexingParams(text) {
  const approxTokens = Math.ceil(text.length / TOKEN_TO_CHAR_RATIO);

  let chunkTokens = DEFAULT_CHUNK_TOKENS;
  let overlapTokens = DEFAULT_OVERLAP_TOKENS;
  let batchSize = DEFAULT_BATCH_SIZE;

  if (approxTokens <= 4_000) {
    chunkTokens = 800;
    overlapTokens = 160;
    batchSize = 32;
  } else if (approxTokens <= 20_000) {
    chunkTokens = 1000;
    overlapTokens = 200;
    batchSize = 24;
  } else if (approxTokens <= 80_000) {
    chunkTokens = 1200;
    overlapTokens = 240;
    batchSize = 20;
  } else {
    chunkTokens = 1400;
    overlapTokens = 280;
    batchSize = 16;
  }

  const chunkSize = Math.max(400, chunkTokens * TOKEN_TO_CHAR_RATIO);
  let overlap = Math.max(80, overlapTokens * TOKEN_TO_CHAR_RATIO);
  if (overlap >= chunkSize) {
    overlap = Math.floor(chunkSize / 5);
  }

  return { chunkSize, overlap, batchSize };
}

async function indexPdfById(pdfId) {
  const startedAt = Date.now();
  const pdf = getPdfById(pdfId);
  if (!pdf) {
    return { indexedChunks: 0, skipped: true };
  }

  try {
    const fileBuffer = await fs.readFile(pdf.path);
    const rawText = await extractTextFromPdfBuffer(fileBuffer);
    const indexingParams = getIndexingParams(rawText);
    const chunks = chunkText(rawText, {
      chunkSize: indexingParams.chunkSize,
      overlap: indexingParams.overlap,
    });

    if (chunks.length === 0) {
      markPdfFailed(pdfId);
      return { indexedChunks: 0, failed: true };
    }

    const embeddingStartedAt = Date.now();
    const vectors = await generateEmbeddings(chunks, {
      batchSize: indexingParams.batchSize,
    });

    const items = chunks.map((text, index) => ({
      text,
      embedding: vectors[index],
    }));

    const inserted = addChunks({
      sessionId: pdf.sessionId,
      pdfId: pdf.id,
      items,
    });

    markPdfIndexed(pdfId, inserted);
    logInfo('INDEX_DONE', {
      pdfId,
      sessionId: pdf.sessionId,
      indexedChunks: inserted,
      status: 'indexed',
    });

    return {
      indexedChunks: inserted,
      indexingTimeMs: Date.now() - startedAt,
      embeddingTimeMs: Date.now() - embeddingStartedAt,
    };
  } catch (error) {
    markPdfFailed(pdfId);
    logError('ERROR_QUEUE', error, {
      pdfId,
      sessionId: pdf.sessionId,
      stage: 'indexPdfById',
    });
    throw error;
  }
}

module.exports = {
  indexPdfById,
};
