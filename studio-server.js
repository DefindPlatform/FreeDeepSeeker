#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/agent-core.js');
const projectIndex = require('./lib/project-index.js');

function parseArgs(argv) {
  const options = { workspace: process.cwd(), port: 9660 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-C' || arg === '--workspace') {
      if (argv[i + 1] === undefined) throw new Error(`Для ${arg} требуется значение`);
      options.workspace = argv[++i];
    }
    else if (arg === '--port') {
      if (argv[i + 1] === undefined) throw new Error('Для --port требуется значение');
      options.port = Number(argv[++i]);
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Неизвестный параметр: ${arg}`);
  }
  options.workspace = path.resolve(options.workspace);
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Некорректный --port');
  return options;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function assertLocalRequest(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new Error('Недопустимый Host');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = String(req.headers.origin || '');
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new Error('Запрос с внешнего Origin отклонён');
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw new Error('Cross-site запрос отклонён');
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function readJson(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function loadRuns(workspace) {
  const runsDir = path.join(workspace, core.STATE_DIR, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).sort().reverse().slice(0, 30).flatMap(name => {
    const file = path.join(runsDir, name, 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const runDir = path.dirname(file);
      return [{
        id: manifest.id,
        task: manifest.task,
        status: manifest.status,
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt || null,
        entries: manifest.entries || [],
        events: manifest.events || [],
        diffs: (manifest.entries || []).map(entry => buildEntryDiff(workspace, runDir, entry)).filter(Boolean),
      }];
    } catch { return []; }
  });
}

function readOptionalText(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 1000000) return '';
    const buffer = fs.readFileSync(file);
    return buffer.includes(0) ? '' : buffer.toString('utf8');
  } catch { return ''; }
}

function readStudioFile(file, maxBytes) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Выбранный путь не является файлом');
  if (stat.size > maxBytes) throw new Error(`Файл слишком большой для просмотра: ${stat.size} байт`);
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) return `// Бинарный файл (${stat.size} байт) нельзя показать как текст.`;
  return buffer.toString('utf8');
}

function buildEntryDiff(workspace, runDir, entry) {
  const target = path.join(workspace, entry.path);
  const backup = entry.backup ? path.join(runDir, entry.backup) : null;
  const before = backup ? readOptionalText(backup) : '';
  const after = readOptionalText(target);
  if (!before && !after) return null;
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
  return { path: entry.path, startLine: prefix + 1, removed: oldLines.slice(prefix, oldEnd + 1).slice(0, 200), added: newLines.slice(prefix, newEnd + 1).slice(0, 200) };
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' })[ext] || 'application/octet-stream';
}

function createStudioServer(options) {
  const workspace = fs.realpathSync(options.workspace);
  const config = core.loadProjectConfig(workspace);
  const dist = path.join(__dirname, 'dashboard', 'dist');
  const apiBaseUrl = String(process.env.DEEPSEEK_API_URL || 'http://127.0.0.1:9655').replace(/\/+$/, '');
  const apiHeaders = process.env.FREEDEEPSEEK_API_KEY ? { Authorization: `Bearer ${process.env.FREEDEEPSEEK_API_KEY}` } : {};
  let task = null;

  const state = async () => {
    const [health, models] = await Promise.all([
      fetch(`${apiBaseUrl}/health`, { headers: apiHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${apiBaseUrl}/v1/models`, { headers: apiHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return {
      workspace,
      config: { permissionMode: config.permissionMode },
      project: projectIndex.createProjectIndex(workspace, config),
      runs: loadRuns(workspace),
      task,
      api: { online: Boolean(health), baseUrl: apiBaseUrl, health, models: models?.data || [] },
    };
  };

  const startTask = body => {
    if (task?.status === 'running') throw new Error('Задача уже выполняется');
    const prompt = String(body.prompt || '').trim();
    const model = String(body.model || 'deepseek-chat');
    const requestedMode = String(body.mode || 'ask');
    if (!['read-only', 'ask', 'full'].includes(requestedMode)) throw new Error('Некорректный режим');
    if (requestedMode === 'ask' && body.approved !== true) throw new Error('Для режима ask требуется подтверждение задачи');
    const executionMode = requestedMode === 'ask' ? 'full' : requestedMode;
    if (!prompt) throw new Error('Пустая задача');
    const taskRecord = { id: `studio-${Date.now()}`, prompt, model, mode: requestedMode, status: 'running', startedAt: new Date().toISOString(), lines: [] };
    task = taskRecord;
    const child = spawn(process.execPath, [path.join(__dirname, 'agent.js'), '-C', workspace, '--mode', executionMode, '--model', model, '--', prompt], {
      cwd: workspace,
      windowsHide: true,
      env: process.env,
    });
    taskRecord.pid = child.pid;
    const append = (stream, chunk) => {
      String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => taskRecord.lines.push({ at: new Date().toISOString(), stream, text: line.replace(/\x1b\[[0-9;]*m/g, '') }));
      taskRecord.lines = taskRecord.lines.slice(-5000);
    };
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.on('close', code => { taskRecord.status = code === 0 ? 'completed' : 'failed'; taskRecord.exitCode = code; taskRecord.finishedAt = new Date().toISOString(); });
    child.on('error', error => { taskRecord.status = 'failed'; taskRecord.error = error.message; taskRecord.finishedAt = new Date().toISOString(); });
    return taskRecord;
  };

  return http.createServer(async (req, res) => {
    try {
      setSecurityHeaders(res);
      assertLocalRequest(req, options.port);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const file = core.resolveWorkspacePath(workspace, url.searchParams.get('path') || '');
        core.assertAccessible(workspace, file, config, 'studio-read');
        return json(res, 200, { path: core.normalizeRelative(workspace, file), content: readStudioFile(file, config.maxFileBytes) });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') return json(res, 202, startTask(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/undo') return json(res, 200, core.undoLatestRun(workspace));
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

      if (!fs.existsSync(dist)) return json(res, 503, { error: 'Dashboard is not built. Run npm run studio:build.' });
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      let file = path.resolve(dist, relative);
      if (!core.isInside(dist, file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
      res.writeHead(200, { 'Content-Type': mimeType(file), 'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
      fs.createReadStream(file).pipe(res);
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('deepseek-studio -C <workspace> [--port 9660]');
    return;
  }
  if (!fs.existsSync(options.workspace) || !fs.statSync(options.workspace).isDirectory()) throw new Error(`Workspace не найден: ${options.workspace}`);
  const server = createStudioServer(options);
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`DeepSeek Agent Studio: http://127.0.0.1:${options.port}`);
    console.log(`Workspace: ${options.workspace}`);
  });
  const shutdown = () => server.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) main().catch(error => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
module.exports = { parseArgs, createStudioServer, loadRuns, buildEntryDiff, assertLocalRequest, readStudioFile };
