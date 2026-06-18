const path = require('path');

function integer(name, value, fallback, { min, max }) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function exactOrigin(value) {
  if (!value) return '';
  if (value === '*') throw new Error('CORS_ORIGIN must be one exact http(s) origin, not *');
  let url;
  try { url = new URL(value); } catch { throw new Error('CORS_ORIGIN must be a valid URL origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, '')) {
    throw new Error('CORS_ORIGIN must contain only scheme, host and optional port');
  }
  return url.origin;
}

function loadServerConfig(env = process.env, baseDir = path.resolve(__dirname, '..')) {
  const host = String(env.HOST || '127.0.0.1').trim();
  if (!host || /[\s/]/.test(host)) throw new Error('HOST is invalid');
  return Object.freeze({
    host,
    port: integer('PORT', env.PORT, 9655, { min: 1024, max: 65535 }),
    apiKey: String(env.FREEDEEPSEEK_API_KEY || ''),
    corsOrigin: exactOrigin(String(env.CORS_ORIGIN || '').replace(/\/$/, '')),
    maxRequestBytes: integer('MAX_REQUEST_BYTES', env.MAX_REQUEST_BYTES, 2 * 1024 * 1024, { min: 1024, max: 100 * 1024 * 1024 }),
    rateLimitPerMinute: integer('RATE_LIMIT_PER_MINUTE', env.RATE_LIMIT_PER_MINUTE, 120, { min: 0, max: 100000 }),
    accountCooldownMs: integer('DEEPSEEK_ACCOUNT_COOLDOWN_MS', env.DEEPSEEK_ACCOUNT_COOLDOWN_MS, 10 * 60 * 1000, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    authPath: String(env.DEEPSEEK_AUTH_PATH || path.join(baseDir, 'deepseek-auth.json')),
  });
}

module.exports = { loadServerConfig };
