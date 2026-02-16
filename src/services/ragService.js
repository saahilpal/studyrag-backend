const {
  getGenAI,
  getGenerationModelCandidates,
  getGeminiErrorDetails,
  isGeminiNotFoundError,
} = require('../config/gemini');
const { generateEmbedding } = require('./embeddingService');
const { similaritySearch, getChunkCountBySession } = require('./vectorService');
const { logError } = require('../utils/logger');

const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K) || 5;
const DEFAULT_CANDIDATE_LIMIT = Number(process.env.RAG_CANDIDATE_LIMIT) || 300;
const DEFAULT_HISTORY_LIMIT = Number(process.env.RAG_HISTORY_LIMIT) || 12;

function createGenerationError(message, details) {
  const error = new Error(message);
  error.statusCode = 500;
  error.gemini = details || null;
  return error;
}

function formatHistory(history = []) {
  return history
    .slice(-DEFAULT_HISTORY_LIMIT)
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join('\n');
}

async function generateTextWithFallback({ prompt, generationConfig }) {
  const ai = getGenAI();
  const models = getGenerationModelCandidates();
  let lastError = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: prompt,
          config: generationConfig,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Gemini request timeout.')), 25_000);
        }),
      ]);

      return response?.text || '';
    } catch (error) {
      lastError = error;
      const details = getGeminiErrorDetails(error);
      const hasNext = i < models.length - 1;
      if (isGeminiNotFoundError(error) && hasNext) {
        continue;
      }

      throw createGenerationError(
        isGeminiNotFoundError(error)
          ? `Generation model "${model}" is unavailable.`
          : 'Gemini generation request failed.',
        details
      );
    }
  }

  throw createGenerationError('Gemini generation failed for all configured models.', getGeminiErrorDetails(lastError));
}

async function runChatQuery({ sessionId, message, history = [], topK = DEFAULT_TOP_K }) {
  const queryEmbedding = await generateEmbedding(message);
  const normalizedTopK = Math.max(1, Math.min(5, Number(topK) || DEFAULT_TOP_K));
  const candidates = await similaritySearch({
    sessionId,
    queryEmbedding,
    topK: normalizedTopK,
    limit: DEFAULT_CANDIDATE_LIMIT,
    offset: 0,
  });

  if (candidates.length === 0) {
    return {
      answer: "I don't know - please provide more context.",
      sources: [],
      usedChunksCount: 0,
    };
  }

  const context = candidates
    .map((chunk, index) => `Chunk ${index + 1} (pdfId=${chunk.pdfId}, score=${chunk.score.toFixed(4)}):\n${chunk.text}`)
    .join('\n\n');

  const prompt = `You are a PDF analysis assistant.\nUse ONLY the provided context chunks and chat history.\nIf the answer is not found in context, reply exactly: I don't know - please provide more context.\n\nRecent chat history:\n${formatHistory(history)}\n\nUser message:\n${message}\n\nContext:\n${context}`;

  let answer = "I don't know - please provide more context.";
  try {
    answer = (await generateTextWithFallback({ prompt })) || answer;
  } catch (error) {
    logError('ERROR_QUEUE', error, {
      service: 'ragService',
      stage: 'runChatQueryGeneration',
      sessionId,
    });
  }

  return {
    answer,
    sources: candidates.map((chunk) => ({
      pdfId: chunk.pdfId,
      chunkId: chunk.chunkId,
      score: chunk.score,
    })),
    usedChunksCount: candidates.length,
  };
}

function shouldRunAsyncChat({ sessionId, history = [] }) {
  const chunkCount = getChunkCountBySession(sessionId);
  return chunkCount > 1200 || history.length > 20;
}

module.exports = {
  runChatQuery,
  shouldRunAsyncChat,
};
