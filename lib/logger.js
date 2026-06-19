const { randomUUID } = require('crypto');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
const SECRET_KEY = /authorization|cookie|token|api.?key|password|secret/i;

function redact(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/(sessionid|auth_token|token)=([^;\s]+)/gi, '$1=[REDACTED]');
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, seen)]));
}

function createLogger({ service = 'freedeepseekapi', level = process.env.LOG_LEVEL || 'info', format = process.env.LOG_FORMAT || 'text', stream = process.stderr, now = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (severity, event, fields = {}) => {
    if (LEVELS[severity] < threshold) return;
    const record = redact({ time: now().toISOString(), level: severity, service, event, ...fields });
    if (format === 'json') stream.write(`${JSON.stringify(record)}\n`);
    else {
      const { time, level: recordLevel, service: recordService, event: recordEvent, ...rest } = record;
      const details = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      stream.write(`${time} ${recordLevel.toUpperCase()} [${recordService}] ${recordEvent}${details}\n`);
    }
  };
  return Object.freeze({
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  });
}

function attachRequestLog(req, res, logger, { idFactory = randomUUID, clock = Date.now } = {}) {
  const supplied = String(req.headers['x-request-id'] || '');
  const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : idFactory();
  const startedAt = clock();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.once('finish', () => logger.info('http_request', {
    requestId,
    method: req.method,
    path: String(req.url || '').split('?')[0],
    status: res.statusCode,
    durationMs: Math.max(0, clock() - startedAt),
    remoteAddress: req.socket?.remoteAddress || null,
  }));
  return requestId;
}

module.exports = { LEVELS, redact, createLogger, attachRequestLog };
