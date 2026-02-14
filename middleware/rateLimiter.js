// Simple in-memory rate limiter suitable for local development.
// For production with multiple instances, use Redis or another shared store.
const requestStore = new Map();
const MAX_TRACKED_IPS = 10_000;

function pruneRequestStore(now, windowMs) {
  for (const [ip, entry] of requestStore.entries()) {
    if (now - entry.windowStart >= windowMs) {
      requestStore.delete(ip);
    }
  }

  while (requestStore.size > MAX_TRACKED_IPS) {
    const oldestKey = requestStore.keys().next().value;
    requestStore.delete(oldestKey);
  }
}

function rateLimiter({ windowMs = 60_000, maxRequests = 60 } = {}) {
  return function rateLimitHandler(req, res, next) {
    const key = req.ip;
    const now = Date.now();

    pruneRequestStore(now, windowMs);

    const entry = requestStore.get(key) || {
      count: 0,
      windowStart: now,
    };

    // Reset window when time passes
    if (now - entry.windowStart >= windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count += 1;
    requestStore.set(key, entry);

    if (entry.count > maxRequests) {
      const retryAfterSeconds = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        error: `Rate limit exceeded. Try again in ${retryAfterSeconds}s.`,
      });
    }

    return next();
  };
}

module.exports = rateLimiter;
