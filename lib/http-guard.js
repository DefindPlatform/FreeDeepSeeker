const crypto = require('crypto');

function createHttpGuard({ apiKey = '', corsOrigin = '', rateLimitPerMinute = 120 } = {}) {
  const buckets = new Map();

  function applyCors(req, res) {
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-agent-session');
    if (req.method !== 'OPTIONS') return false;
    res.writeHead(204);
    res.end();
    return true;
  }

  function hasValidApiKey(req) {
    if (!apiKey) return true;
    const header = String(req.headers.authorization || '');
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expectedBuffer = Buffer.from(apiKey);
    const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
  }

  function consumeRateLimit(req) {
    if (rateLimitPerMinute === 0) return { allowed: true, remaining: null };
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= 60000) bucket = { startedAt: now, count: 0 };
    bucket.count++;
    buckets.set(key, bucket);
    return { allowed: bucket.count <= rateLimitPerMinute, remaining: Math.max(0, rateLimitPerMinute - bucket.count) };
  }

  return { applyCors, hasValidApiKey, consumeRateLimit };
}

module.exports = { createHttpGuard };
