const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STATE_DIR = '.deepseek-agent';
const DEFAULT_ALLOWED_PROGRAMS = [
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'pytest', 'pip', 'pip3',
  'git', 'cargo', 'rustc', 'go', 'dotnet', 'java', 'javac', 'mvn', 'gradle', 'gradlew',
];
const PROTECTED_NAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.pypirc',
  'deepseek-auth.json', 'auth.json', 'credentials', 'credentials.json',
  'id_rsa', 'id_ed25519', 'known_hosts',
]);

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function nearestExisting(filePath) {
  let current = filePath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function resolveWorkspacePath(root, requested = '.') {
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, String(requested || '.'));
  if (!isInside(realRoot, candidate)) throw new Error(`Путь выходит за рабочую папку: ${requested}`);
  const existing = nearestExisting(candidate);
  const realExisting = fs.realpathSync(existing);
  if (!isInside(realRoot, realExisting)) throw new Error(`Путь проходит через симлинк за пределы рабочей папки: ${requested}`);
  return candidate;
}

function normalizeRelative(root, target) {
  return (path.relative(root, target) || '.').split(path.sep).join('/');
}

function isProtectedPath(root, target, extraPatterns = []) {
  const relative = normalizeRelative(root, target).toLowerCase();
  const parts = relative.split('/');
  const base = parts.at(-1);
  if (parts.includes(STATE_DIR)) return true;
  if (PROTECTED_NAMES.has(base) || base.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|kdbx)$/i.test(base)) return true;
  return extraPatterns.some(pattern => {
    const normalized = String(pattern).replace(/\\/g, '/').toLowerCase();
    return relative === normalized || relative.startsWith(`${normalized}/`);
  });
}

function assertAccessible(root, target, config, operation = 'read') {
  if (isProtectedPath(root, target, config.protectedPaths || []) && !config.allowProtectedPaths) {
    throw new Error(`Защищённый путь недоступен для операции ${operation}: ${normalizeRelative(root, target)}`);
  }
}

function loadProjectConfig(root) {
  const defaults = {
    permissionMode: 'ask',
    allowProtectedPaths: false,
    protectedPaths: [],
    allowedPrograms: DEFAULT_ALLOWED_PROGRAMS,
    maxFileBytes: 1000000,
    maxCommandOutputBytes: 100000,
    commandTimeoutMs: 30000,
    rollbackOnFailure: true,
  };
  const file = path.join(root, '.deepseek-agent.json');
  if (!fs.existsSync(file)) return { ...defaults };
  let user;
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Некорректный .deepseek-agent.json: ${error.message}`); }
  const config = { ...defaults, ...user };
  if (!['read-only', 'ask', 'full'].includes(config.permissionMode)) throw new Error('permissionMode должен быть read-only, ask или full');
  if (!Array.isArray(config.allowedPrograms) || !Array.isArray(config.protectedPaths)) throw new Error('allowedPrograms и protectedPaths должны быть массивами');
  // Repository configuration is untrusted. It may restrict the agent, but it cannot
  // silently elevate privileges or expose secrets; only an explicit CLI flag can.
  if (config.permissionMode === 'full') config.permissionMode = 'ask';
  config.allowProtectedPaths = false;
  const builtInPrograms = new Set(DEFAULT_ALLOWED_PROGRAMS.map(item => item.toLowerCase()));
  config.allowedPrograms = config.allowedPrograms
    .map(item => String(item).toLowerCase())
    .filter(item => builtInPrograms.has(item));
  config.maxFileBytes = Math.min(Math.max(Number(config.maxFileBytes) || defaults.maxFileBytes, 1024), 10 * 1024 * 1024);
  config.maxCommandOutputBytes = Math.min(Math.max(Number(config.maxCommandOutputBytes) || defaults.maxCommandOutputBytes, 1024), 1024 * 1024);
  config.commandTimeoutMs = Math.min(Math.max(Number(config.commandTimeoutMs) || defaults.commandTimeoutMs, 1000), 120000);
  return config;
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function snapshotPath(target) {
  if (!fs.existsSync(target)) return { exists: false, type: null, hash: null };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return { exists: true, type: 'symlink', hash: hashBuffer(Buffer.from(fs.readlinkSync(target))) };
  if (stat.isFile()) return { exists: true, type: 'file', hash: hashBuffer(fs.readFileSync(target)) };
  if (stat.isDirectory()) {
    const records = [];
    const visit = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(target, full).split(path.sep).join('/');
        if (entry.isDirectory()) { records.push(`d:${rel}`); visit(full); }
        else if (entry.isSymbolicLink()) records.push(`l:${rel}:${fs.readlinkSync(full)}`);
        else records.push(`f:${rel}:${hashBuffer(fs.readFileSync(full))}`);
      }
    };
    visit(target);
    return { exists: true, type: 'directory', hash: hashBuffer(Buffer.from(records.join('\n'))) };
  }
  return { exists: true, type: 'other', hash: null };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

class RunTransaction {
  constructor(root, task) {
    this.root = fs.realpathSync(root);
    this.id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    this.dir = path.join(this.root, STATE_DIR, 'runs', this.id);
    this.backups = path.join(this.dir, 'backups');
    this.manifestPath = path.join(this.dir, 'manifest.json');
    this.manifest = { version: 1, id: this.id, task, startedAt: new Date().toISOString(), status: 'running', entries: [], events: [] };
    fs.mkdirSync(this.backups, { recursive: true });
    this.flush();
  }

  flush() { atomicWrite(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`); }

  audit(type, data = {}) {
    this.manifest.events.push({ at: new Date().toISOString(), type, ...data });
    this.flush();
  }

  before(target) {
    const relative = normalizeRelative(this.root, target);
    let entry = this.manifest.entries.find(item => item.path === relative);
    if (entry) return entry;
    const snapshot = snapshotPath(target);
    entry = { path: relative, before: snapshot, after: null, backup: null };
    if (snapshot.exists) {
      const backup = path.join(this.backups, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.cpSync(target, backup, { recursive: true, dereference: false, preserveTimestamps: true });
      entry.backup = normalizeRelative(this.dir, backup);
    }
    this.manifest.entries.push(entry);
    this.flush();
    return entry;
  }

  after(target) {
    const relative = normalizeRelative(this.root, target);
    const entry = this.manifest.entries.find(item => item.path === relative);
    if (!entry) throw new Error(`Transaction before() missing for ${relative}`);
    entry.after = snapshotPath(target);
    this.flush();
  }

  finish(status = 'completed', error = null) {
    this.manifest.status = status;
    this.manifest.finishedAt = new Date().toISOString();
    if (error) this.manifest.error = String(error);
    this.flush();
  }
}

function findLatestUndoableRun(root) {
  const runs = path.join(root, STATE_DIR, 'runs');
  if (!fs.existsSync(runs)) return null;
  return fs.readdirSync(runs).sort().reverse().map(name => path.join(runs, name, 'manifest.json')).find(file => {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      return ['completed', 'failed'].includes(manifest.status) && manifest.entries?.length > 0;
    } catch { return false; }
  }) || null;
}

function undoLatestRun(root) {
  const manifestPath = findLatestUndoableRun(root);
  if (!manifestPath) throw new Error('Нет запусков с изменениями для отката');
  const runDir = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const entry of [...manifest.entries].reverse()) {
    const target = resolveWorkspacePath(root, entry.path);
    const current = snapshotPath(target);
    if (entry.after && (current.exists !== entry.after.exists || current.hash !== entry.after.hash)) {
      throw new Error(`Файл изменился после запуска, откат остановлен: ${entry.path}`);
    }
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    if (entry.before.exists) {
      const backup = path.join(runDir, entry.backup);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(backup, target, { recursive: true, dereference: false, preserveTimestamps: true });
    }
  }
  manifest.status = 'undone';
  manifest.undoneAt = new Date().toISOString();
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { runId: manifest.id, restored: manifest.entries.map(entry => entry.path) };
}

function sanitizeEnvironment(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (/(TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PRIVATE_KEY|API[_-]?KEY|ACCESS[_-]?KEY)/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function validateCommand(program, args, root, config) {
  const requestedProgram = String(program || '');
  if (!requestedProgram || path.isAbsolute(requestedProgram) || /[\\/]/.test(requestedProgram)) {
    throw new Error(`Разрешено только имя программы без пути: ${program}`);
  }
  const executable = path.basename(requestedProgram).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  const allowed = config.allowedPrograms.map(item => String(item).toLowerCase());
  if (!allowed.includes(executable)) throw new Error(`Программа не разрешена политикой: ${program}`);
  for (const arg of args) {
    const value = String(arg);
    if (/(^|[=:/\\])\.\.([/\\]|$)/.test(value)) throw new Error(`Аргумент с выходом из рабочей папки запрещён: ${value}`);
    if (path.isAbsolute(value) && !isInside(root, path.resolve(value))) throw new Error(`Абсолютный путь вне workspace запрещён: ${value}`);
  }
  if (executable === 'git') {
    const subcommand = String(args[0] || '').toLowerCase();
    const safeGit = ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files'];
    if (!safeGit.includes(subcommand)) throw new Error(`Изменяющая Git-команда запрещена агенту: git ${subcommand}`);
  }
  return executable;
}

function runProgram(program, args, options) {
  const { cwd, timeoutMs, maxOutputBytes, env = sanitizeEnvironment() } = options;
  return new Promise(resolve => {
    let executable = program;
    let actualArgs = args;
    const normalized = path.basename(String(program)).replace(/\.(cmd|bat|exe)$/i, '').toLowerCase();
    if (process.platform === 'win32' && ['npm', 'npx'].includes(normalized)) {
      const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${normalized}-cli.js`);
      if (!fs.existsSync(cli)) {
        resolve({ exit_code: null, error: `Не найден ${normalized}-cli.js рядом с Node.js`, stdout: '', stderr: '' });
        return;
      }
      executable = process.execPath;
      actualArgs = [cli, ...args];
    } else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(program))) {
      resolve({ exit_code: null, error: 'Запуск .cmd/.bat без shell не поддерживается; используйте прямой executable', stdout: '', stderr: '' });
      return;
    }
    let child;
    try { child = spawn(executable, actualArgs, { cwd, shell: false, windowsHide: true, env }); }
    catch (error) {
      resolve({ exit_code: null, error: error.message, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => {
      const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
      return combined.subarray(Math.max(0, combined.length - maxOutputBytes)).toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ exit_code: code, timed_out: timedOut, stdout, stderr }); });
    child.on('error', error => { clearTimeout(timer); resolve({ exit_code: null, error: error.message, stdout, stderr }); });
  });
}

module.exports = {
  STATE_DIR, DEFAULT_ALLOWED_PROGRAMS, isInside, resolveWorkspacePath, normalizeRelative,
  isProtectedPath, assertAccessible, loadProjectConfig, snapshotPath, atomicWrite,
  RunTransaction, undoLatestRun, sanitizeEnvironment, validateCommand, runProgram,
};
