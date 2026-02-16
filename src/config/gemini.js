const { GoogleGenAI, ApiError } = require('@google/genai');

let geminiClient;

// Current model names change over time. Check:
// 1) https://ai.google.dev/gemini-api/docs/models
// 2) SDK listing API: ai.models.list()
const DEFAULT_GENERATION_MODEL = 'gemini-2.5-flash';

function getGenAI() {
  if (geminiClient) {
    return geminiClient;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in .env');
  }

  geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
}

function splitCandidates(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(items) {
  return [...new Set(items)];
}

function getGenerationModelCandidates() {
  const configured = splitCandidates(process.env.GEMINI_MODEL);
  return unique([...configured, DEFAULT_GENERATION_MODEL]);
}

function getGeminiErrorDetails(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name,
    status: Number(error.status) || undefined,
    message: error.message || 'Unknown Gemini SDK error.',
    // The SDK keeps body details mostly inside message/cause depending on path.
    // Capture the likely raw payload fields so logs are actionable.
    responseBody:
      error.responseBody ||
      error.body ||
      error.error ||
      error.details ||
      error.cause?.body ||
      error.cause?.error ||
      null,
  };
}

function isGeminiNotFoundError(error) {
  const status = Number(error?.status);
  if (status === 404) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return message.includes('404') || message.includes('not found');
}

function isGeminiApiError(error) {
  return error instanceof ApiError || typeof error?.status === 'number';
}

module.exports = {
  DEFAULT_GENERATION_MODEL,
  getGenAI,
  getGenerationModelCandidates,
  getGeminiErrorDetails,
  isGeminiNotFoundError,
  isGeminiApiError,
};
