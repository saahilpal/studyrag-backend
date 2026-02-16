const SAFE_CLIENT_STATUS_CODES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = Number(statusCode) || 500;
  return error;
}

function normalizeHttpError(error) {
  const candidateStatus = Number(error?.statusCode || error?.status) || 500;
  const status = SAFE_CLIENT_STATUS_CODES.has(candidateStatus) ? candidateStatus : 500;
  const message = status === 500
    ? 'Internal server error.'
    : (error?.message || 'Request failed.');

  return {
    status,
    message,
  };
}

module.exports = {
  createHttpError,
  normalizeHttpError,
};
