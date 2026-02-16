const pdfParse = require('pdf-parse');
const { logError } = require('../utils/logger');

/**
 * Extracts text content from a PDF buffer.
 * @param {Buffer} buffer - The PDF file buffer
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromPdfBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Invalid PDF buffer.');
  }

  try {
    const data = await pdfParse(buffer);

    if (!data || !data.text) {
      throw new Error('PDF parsing failed. No text returned.');
    }

    const cleanedText = data.text.trim();

    if (!cleanedText) {
      throw new Error(
        'Could not extract text from PDF. The file may be scanned or empty.'
      );
    }

    return cleanedText;
  } catch (error) {
    logError('ERROR_UPLOAD', error, { service: 'pdfService' });
    throw new Error('Failed to parse PDF.');
  }
}

module.exports = {
  extractTextFromPdfBuffer,
};
