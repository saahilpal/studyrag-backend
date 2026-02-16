function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return {};
  }

  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      clean[key] = value.length > 300 ? `${value.slice(0, 297)}...` : value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      clean[key] = value;
      continue;
    }
    clean[key] = String(value);
  }
  return clean;
}

function write(level, event, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeMeta(meta),
  };

  const line = JSON.stringify(payload);
  if (level === 'ERROR') {
    // eslint-disable-next-line no-console
    console.error(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.info(line);
}

function logInfo(event, meta = {}) {
  write('INFO', event, meta);
}

function logError(event, error, meta = {}) {
  const message = error?.message ? String(error.message) : 'Unknown error';
  write('ERROR', event, {
    ...meta,
    message,
  });
}

module.exports = {
  logInfo,
  logError,
};
