const fs = require('fs/promises');
const path = require('path');

const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
const MAX_UPLOAD_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES) || 50 * 1024 * 1024;
const ALLOWED_PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf']);

function sanitizeFilename(filename) {
  return String(filename || 'upload.pdf')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

function isPathWithinUploadsRoot(candidatePath) {
  const resolvedPath = path.resolve(String(candidatePath || ''));
  return resolvedPath === uploadsRoot || resolvedPath.startsWith(`${uploadsRoot}${path.sep}`);
}

function ensurePdfFile(file) {
  const mimetype = String(file?.mimetype || '').toLowerCase();
  const originalname = String(file?.originalname || '').toLowerCase();
  const fileSize = Number(file?.size || 0);
  const header = Buffer.isBuffer(file?.buffer) ? file.buffer.subarray(0, 5).toString('ascii') : '';

  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) {
    const error = new Error('Uploaded file is empty or invalid.');
    error.statusCode = 400;
    throw error;
  }

  if (!ALLOWED_PDF_MIME_TYPES.has(mimetype)) {
    const error = new Error('Invalid MIME type. Only PDF uploads are allowed.');
    error.statusCode = 415;
    throw error;
  }

  if (!originalname.endsWith('.pdf')) {
    const error = new Error('File extension must be .pdf.');
    error.statusCode = 400;
    throw error;
  }

  if (header !== '%PDF-') {
    const error = new Error('Invalid PDF file signature.');
    error.statusCode = 400;
    throw error;
  }

  if (fileSize <= 0 || fileSize > MAX_UPLOAD_FILE_SIZE_BYTES) {
    const error = new Error('Uploaded file exceeds configured size limit.');
    error.statusCode = 400;
    throw error;
  }
}

function createUploadPathError() {
  const error = new Error('File path is outside allowed uploads directory.');
  error.statusCode = 400;
  return error;
}

async function ensureSessionUploadDir(sessionId) {
  const dir = path.join(uploadsRoot, String(sessionId));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function saveUploadedPdfById({ sessionId, pdfId, file }) {
  ensurePdfFile(file);

  const filename = `${pdfId}.pdf`;
  const sessionDir = await ensureSessionUploadDir(sessionId);
  const absolutePath = path.join(sessionDir, filename);

  if (!isPathWithinUploadsRoot(absolutePath)) {
    throw createUploadPathError();
  }

  // Use exclusive write to prevent accidental overwrite/collision.
  try {
    await fs.writeFile(absolutePath, file.buffer, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const collisionError = new Error('PDF file collision detected. Retry upload.');
      collisionError.statusCode = 400;
      throw collisionError;
    }
    throw error;
  }

  return {
    filename,
    storagePath: absolutePath,
  };
}

async function removeStoredPdf(storagePath) {
  if (!isPathWithinUploadsRoot(storagePath)) {
    throw createUploadPathError();
  }

  await fs.unlink(path.resolve(storagePath));
}

module.exports = {
  uploadsRoot,
  isPathWithinUploadsRoot,
  sanitizeFilename,
  saveUploadedPdfById,
  removeStoredPdf,
};
