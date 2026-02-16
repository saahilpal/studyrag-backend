function normalizeWhitespace(input) {
  return input.replace(/\s+/g, ' ').trim();
}

function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize || 1000;
  const overlap = options.overlap || 200;

  if (chunkSize <= overlap) {
    throw new Error('chunkSize must be greater than overlap.');
  }

  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    chunks.push(normalized.slice(start, end));

    if (end === normalized.length) {
      break;
    }

    start = end - overlap;
  }

  return chunks;
}

module.exports = {
  chunkText,
};
