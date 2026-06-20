const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../server.js').__test;
const clientInternals = require('../client.js').__test;
const agentInternals = require('../agent.js').__test;
const agentCore = require('../lib/agent-core.js');
const { ToolRegistry, createCodingToolRegistry } = require('../lib/tool-registry.js');
const { AgentRunController, toolSignature } = require('../lib/agent-runtime.js');
const projectMemory = require('../lib/project-memory.js');
const projectIndex = require('../lib/project-index.js');
const studio = require('../studio-server.js');
const { loadServerConfig } = require('../lib/server-config.js');
const { createSessionStore } = require('../lib/session-store.js');
const { createHttpGuard } = require('../lib/http-guard.js');
const { createLogger, redact, attachRequestLog } = require('../lib/logger.js');
const { EventEmitter } = require('node:events');
const gitService = require('../lib/git-service.js');
const projectRegistry = require('../lib/project-registry.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-test-'));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

test('server configuration validates ports, limits and exact CORS origins', () => {
  const config = loadServerConfig({ PORT: '9777', RATE_LIMIT_PER_MINUTE: '0', CORS_ORIGIN: 'https://app.example.com/' }, ROOT);
  assert.equal(config.port, 9777);
  assert.equal(config.rateLimitPerMinute, 0);
  assert.equal(config.corsOrigin, 'https://app.example.com');
  assert.throws(() => loadServerConfig({ PORT: '80' }, ROOT), /PORT/);
  assert.throws(() => loadServerConfig({ MAX_REQUEST_BYTES: 'abc' }, ROOT), /MAX_REQUEST_BYTES/);
  assert.throws(() => loadServerConfig({ CORS_ORIGIN: '*' }, ROOT), /CORS_ORIGIN/);
});

test('structured logger redacts secrets and respects levels', () => {
  let output = '';
  const logger = createLogger({ service: 'test', level: 'info', format: 'json', stream: { write: chunk => { output += chunk; } }, now: () => new Date('2026-01-01T00:00:00.000Z') });
  logger.debug('hidden', { value: 1 });
  logger.info('visible', { token: 'raw-token', nested: { authorization: 'Bearer abc.def', note: 'token=abc' } });
  const record = JSON.parse(output);
  assert.equal(record.event, 'visible');
  assert.equal(record.token, '[REDACTED]');
  assert.equal(record.nested.authorization, '[REDACTED]');
  assert.equal(record.nested.note, 'token=[REDACTED]');
  assert.equal(redact({ cookie: 'sessionid=secret' }).cookie, '[REDACTED]');
});

test('request logging propagates a safe correlation id', () => {
  const req = { method: 'GET', url: '/health?secret=yes', headers: { 'x-request-id': 'test-123' }, socket: { remoteAddress: '127.0.0.1' } };
  const res = new EventEmitter();
  res.statusCode = 204;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  const events = [];
  const requestId = attachRequestLog(req, res, { info: (event, fields) => events.push({ event, fields }) }, { clock: () => 10 });
  res.emit('finish');
  assert.equal(requestId, 'test-123');
  assert.equal(res.headers['X-Request-Id'], 'test-123');
  assert.equal(events[0].fields.path, '/health');
  assert.equal(events[0].fields.durationMs, 0);
});

test('Git service reports, commits and pushes a workspace safely', () => {
  const root = tmpdir();
  const remoteParent = tmpdir();
  const remote = path.join(remoteParent, 'remote.git');
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(git(['init']).status, 0);
  assert.equal(git(['config', 'user.email', 'tests@example.invalid']).status, 0);
  assert.equal(git(['config', 'user.name', 'FreeDeepSeeker Tests']).status, 0);
  fs.writeFileSync(path.join(root, 'README.md'), '# initial\n');
  assert.equal(git(['add', 'README.md']).status, 0);
  assert.equal(git(['commit', '-m', 'Initial']).status, 0);
  fs.appendFileSync(path.join(root, 'README.md'), 'changed\n');
  fs.writeFileSync(path.join(root, 'new.js'), 'module.exports = true;\n');
  const dirty = gitService.getGitState(root);
  assert.equal(dirty.repository, true);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.files.length, 2);
  assert.match(dirty.diff, /changed/);
  const committed = gitService.commitAll(root, 'Test safe commit');
  assert.match(committed.hash, /^[0-9a-f]+$/);
  assert.equal(gitService.getGitState(root).dirty, false);
  assert.equal(spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8', windowsHide: true }).status, 0);
  assert.equal(git(['remote', 'add', 'origin', remote]).status, 0);
  const pushed = gitService.pushCurrent(root);
  assert.match(pushed.upstream, /^origin\//);
  assert.throws(() => gitService.commitAll(root, 'bad\nmessage'), /одной строке/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(remoteParent, { recursive: true, force: true });
});

test('project registry validates, deduplicates and describes workspaces', () => {
  const root = tmpdir();
  const second = tmpdir();
  const registryFile = path.join(tmpdir(), 'projects.json');
  let projects = projectRegistry.addProject([], root, registryFile);
  projects = projectRegistry.addProject(projects, second, registryFile);
  projects = projectRegistry.addProject(projects, root, registryFile);
  assert.deepEqual(projects, [fs.realpathSync(root), fs.realpathSync(second)]);
  assert.deepEqual(projectRegistry.readProjects(registryFile), projects);
  assert.equal(projectRegistry.describeProjects(projects, projects[0])[0].active, true);
  assert.throws(() => projectRegistry.validateProject(path.join(root, 'missing')), /не найдена/);
});

test('session store bounds history and resets one or all sessions', () => {
  const store = createSessionStore({ maxHistoryLength: 2, maxHistoryChars: 1000 });
  store.store('agent-a', 'one', 'answer');
  store.store('agent-a', 'two', 'answer');
  store.store('agent-a', 'three', 'answer');
  assert.equal(store.get('agent-a').history.length, 2);
  assert.equal(store.list()[0].agent, 'agent-a');
  assert.equal(store.reset('agent-a', false).historyCount, 2);
  assert.equal(store.get('agent-a').history.length, 2);
  assert.equal(store.reset('all').count, 1);
  assert.equal(store.sessions.size, 0);
});

test('HTTP guard performs constant-time API auth and per-address limits', () => {
  const guard = createHttpGuard({ apiKey: 'test-key', rateLimitPerMinute: 2 });
  const request = { headers: { authorization: 'Bearer test-key' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET' };
  assert.equal(guard.hasValidApiKey(request), true);
  assert.equal(guard.hasValidApiKey({ ...request, headers: {} }), false);
  assert.equal(guard.consumeRateLimit(request).allowed, true);
  assert.equal(guard.consumeRateLimit(request).allowed, true);
  assert.equal(guard.consumeRateLimit(request).allowed, false);
});

test('auth import copies valid deepseek-auth.json and chmods it to 0600', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'source-auth.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify({
    token: 'tok_123',
    cookie: 'ds_session_id=abc; other=def',
    hif_dliq: 'dliq',
    hif_leim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
  }));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_123');
  assert.match(imported.cookie, /ds_session_id=abc/);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(dst).mode & 0o777), 0o600);
  }
});

test('auth import accepts browser cookie export plus token env', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([
    { domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' },
    { domain: 'chat.deepseek.com', name: 'smidV2', value: 'smid' },
    { domain: 'example.com', name: 'ignored', value: 'nope' },
  ]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst], { env: { DEEPSEEK_TOKEN: 'tok_env' } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_env');
  assert.equal(imported.cookie, 'ds_session_id=abc; smidV2=smid');
});

test('auth import rejects token passed as CLI arg before prompting or reading files', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([{ domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' }]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst, '--token', 'tok_cli']);
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /Refusing --token/i);
  assert.equal(fs.existsSync(dst), false);

  const noInput = runNode(['scripts/auth_import.js', '--token', 'tok_cli']);
  assert.equal(noInput.status, 2);
  assert.match(noInput.stderr + noInput.stdout, /Refusing --token/i);

  const badInput = runNode(['scripts/auth_import.js', '--input', path.join(dir, 'missing.json'), '--token', 'tok_cli']);
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr + badInput.stdout, /Refusing --token/i);
});

test('auth import help ignores comma-list DEEPSEEK_AUTH_PATH as default output', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const res = runNode(['scripts/auth_import.js', '--help'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.match(res.stdout, /deepseek-auth\.json/);
});

test('doctor reports auth problems without requiring Chrome or network', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token: '', cookie: '' }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /token missing/i);
  assert.match(res.stdout + res.stderr, /cookie missing/i);
});

test('doctor exits cleanly when offline auth checks pass', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'valid-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    token: 'tok_123',
    cookie: 'sessionid=cookie_123',
    wasmUrl: 'https://chat.deepseek.com/static/pow.wasm',
  }));
  if (process.platform !== 'win32') fs.chmodSync(authPath, 0o600);
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /auth file looks OK/i);
});

test('chrome auth prints actionable OS instructions when Chrome is missing', () => {
  const dir = tmpdir();
  const fakeChrome = path.join(dir, 'missing-chrome');
  const res = runNode(['scripts/deepseek_chrome_auth.js'], { env: { CHROME_PATH: fakeChrome } });
  assert.notEqual(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /Windows/i);
  assert.match(out, /macOS/i);
  assert.match(out, /Linux/i);
  assert.match(out, /CHROME_PATH/i);
});

test('DeepSeek stream parser treats SEARCH fragments as assistant output', () => {
  const rebuilt = serverInternals.rebuildFragmentText([
    { type: 'SEARCH', content: 'The official Reuters website is ' },
    { type: 'SEARCH', content: 'https://www.reuters.com/.' },
  ]);

  assert.equal(rebuilt.responseText, 'The official Reuters website is https://www.reuters.com/.');
  assert.equal(rebuilt.thinkText, '');
});

test('DeepSeek stream parser applies response-level fragment append patches', () => {
  const fragments = [];
  const appendFragments = (value) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) fragments.push({ ...fragment });
  };

  const applied = serverInternals.applyResponsePatchOperations([
    { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'The' }] },
    { p: 'has_pending_fragment', o: 'SET', v: false },
  ], appendFragments);

  assert.equal(applied, true);
  assert.deepEqual(fragments, [{ type: 'RESPONSE', content: 'The' }]);
  assert.equal(serverInternals.rebuildFragmentText(fragments).responseText, 'The');
});

test('DeepSeek stream parser does not treat service content chunks as model errors', () => {
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ content: 'Official Reuters website URL' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ finish_reason: 'stop' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ type: 'error', content: 'backend error' }), true);
});

test('CLI parses model, system prompt, URL and non-stream mode', () => {
  const args = clientInternals.parseArgs([
    '--model=deepseek-reasoner',
    '--system', 'Отвечай кратко',
    '--url', 'http://localhost:9999/',
    '--no-stream',
    'Привет',
  ]);
  assert.equal(args.model, 'deepseek-reasoner');
  assert.equal(args.system, 'Отвечай кратко');
  assert.equal(args.url, 'http://localhost:9999');
  assert.equal(args.stream, false);
  assert.equal(args.prompt, 'Привет');
  assert.equal(args.autoStart, true);
});

test('CLI prioritizes the main model choices and formats capabilities', () => {
  const models = [
    { id: 'deepseek-r1', capabilities: { reasoning: true } },
    { id: 'deepseek-chat-search', capabilities: { web_search: true, files: true } },
    { id: 'deepseek-chat', capabilities: { files: true } },
  ];
  const sorted = clientInternals.sortModels(models);
  assert.deepEqual(sorted.map(model => model.id), ['deepseek-chat', 'deepseek-chat-search', 'deepseek-r1']);
  assert.equal(clientInternals.capabilityBadges(models[1]), 'search, files');
});

test('CLI auto-start is limited to local API addresses', () => {
  assert.equal(clientInternals.isLocalApi('http://localhost:9655'), true);
  assert.equal(clientInternals.isLocalApi('http://127.0.0.1:9655'), true);
  assert.equal(clientInternals.isLocalApi('https://api.example.com'), false);
  assert.equal(clientInternals.parseArgs(['--no-auto-start']).autoStart, false);
});

test('CLI rejects missing option values and accepts a prompt starting with dashes', () => {
  assert.throws(() => clientInternals.parseArgs(['--model']), /требуется значение/i);
  assert.throws(() => clientInternals.parseArgs(['--url']), /требуется значение/i);
  const args = clientInternals.parseArgs(['--', '--explain-this']);
  assert.equal(args.prompt, '--explain-this');
});

test('coding agent confines paths to its workspace', () => {
  const root = tmpdir();
  const nested = path.join(root, 'src');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'app.js'), 'console.log("ok");');
  assert.equal(agentInternals.resolveWorkspacePath(root, 'src/app.js'), path.join(nested, 'app.js'));
  assert.throws(() => agentInternals.resolveWorkspacePath(root, '../outside.txt'), /выходит за рабочую папку/i);
  assert.equal(agentInternals.isInside(root, nested), true);
  assert.equal(agentInternals.isInside(root, path.dirname(root)), false);
});

test('coding agent parses workspace and autonomous mode', () => {
  const args = agentInternals.parseArgs(['-C', '.', '--yes', '--max-steps=12', '-m', 'deepseek-reasoner', 'Исправь', 'тесты']);
  assert.equal(args.workspace, ROOT);
  assert.equal(args.yes, true);
  assert.equal(args.maxSteps, 12);
  assert.equal(args.model, 'deepseek-reasoner');
  assert.equal(args.prompt, 'Исправь тесты');
});

test('coding agent parses runtime budgets, dry-run and report output', () => {
  const args = agentInternals.parseArgs(['--dry-run', '--max-tool-calls', '17', '--report', 'run.json', 'inspect']);
  assert.equal(args.dryRun, true);
  assert.equal(args.maxToolCalls, 17);
  assert.equal(args.report, path.join(ROOT, 'run.json'));
  assert.throws(() => agentInternals.parseArgs(['--max-tool-calls', '0']), /от 1 до 1000/);
});

test('tool registry exposes provider schemas and permission kinds', () => {
  const registry = createCodingToolRegistry();
  assert.equal(registry.names().length, 11);
  assert.equal(registry.kind('read_file'), 'read');
  assert.equal(registry.kind('write_file'), 'write');
  assert.equal(registry.kind('run_command'), 'command');
  assert.equal(registry.schemas()[0].kind, undefined);
  assert.throws(() => new ToolRegistry([{ kind: 'magic', type: 'function', function: { name: 'bad', parameters: { type: 'object' } } }]), /unknown|неизвестный/i);
});

test('project memory persists typed durable context and updates keys', () => {
  const root = tmpdir();
  projectMemory.rememberProjectMemory(root, { key: 'api-style', value: 'Keep OpenAI compatibility', type: 'constraint' });
  projectMemory.rememberProjectMemory(root, { key: 'api-style', value: 'Keep OpenAI and Anthropic compatibility', type: 'decision' });
  projectMemory.rememberProjectMemory(root, { key: 'next-release', value: 'Add migration notes', type: 'todo' });
  const entries = projectMemory.loadProjectMemory(root);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'decision');
  assert.match(projectMemory.formatProjectMemory(entries), /next-release/);
  assert.equal(projectMemory.forgetProjectMemory(root, 'next-release'), true);
  assert.equal(projectMemory.forgetProjectMemory(root, 'missing'), false);
  projectMemory.clearProjectMemory(root);
  assert.deepEqual(projectMemory.loadProjectMemory(root), []);
});

test('project memory rejects secret-like keys and values', () => {
  assert.throws(() => projectMemory.normalizeEntry({ key: 'api-token', value: 'anything', type: 'fact' }), /секрет|авторизац/i);
  assert.throws(() => projectMemory.normalizeEntry({ key: 'deploy-note', value: 'Bearer abcdefghijklmnop', type: 'fact' }), /секрет/i);
  assert.throws(() => projectMemory.normalizeEntry({ key: 'note', value: 'value', type: 'unknown' }), /тип памяти/i);
});

test('coding agent project-memory tools obey permission and dry-run policy', async () => {
  const root = tmpdir();
  const config = agentCore.loadProjectConfig(root);
  const context = { root, config, transaction: { audit() {}, before() {}, after() {} }, dryRun: true };
  const planned = await agentInternals.executeTool('remember_project_memory', { key: 'style', value: 'Use concise logs', type: 'preference' }, context);
  assert.equal(planned.dry_run, true);
  assert.deepEqual(projectMemory.loadProjectMemory(root), []);
  context.dryRun = false;
  config.permissionMode = 'read-only';
  const denied = await agentInternals.executeTool('remember_project_memory', { key: 'style', value: 'Use concise logs', type: 'preference' }, context);
  assert.equal(denied.denied, true);
  config.permissionMode = 'full';
  const saved = await agentInternals.executeTool('remember_project_memory', { key: 'style', value: 'Use concise logs', type: 'preference' }, context);
  assert.equal(saved.ok, true);
  const read = await agentInternals.executeTool('get_project_memory', { type: 'preference' }, context);
  assert.equal(read.entries.length, 1);
});

test('project memory participates in run rollback', async () => {
  const root = tmpdir();
  const config = agentCore.loadProjectConfig(root);
  config.permissionMode = 'full';
  const transaction = new agentCore.RunTransaction(root, 'memory rollback');
  await agentInternals.executeTool('remember_project_memory', { key: 'temporary-decision', value: 'Ship experimental behavior', type: 'decision' }, { root, config, transaction });
  assert.equal(projectMemory.loadProjectMemory(root).length, 1);
  transaction.finish('failed', 'simulated');
  transaction.rollback('undone');
  assert.deepEqual(projectMemory.loadProjectMemory(root), []);
});

test('agent runtime enforces budgets, detects loops and records a report', () => {
  const runtime = new AgentRunController({ maxSteps: 2, maxToolCalls: 4, repeatLimit: 2, task: 'test', dryRun: true });
  runtime.start();
  assert.equal(runtime.beginStep(), 1);
  runtime.acceptToolCall('read_file', { path: 'a.js', start_line: 1 });
  runtime.acceptToolCall('read_file', { start_line: 1, path: 'a.js' });
  assert.throws(() => runtime.acceptToolCall('read_file', { path: 'a.js', start_line: 1 }), /цикл/i);
  runtime.recordUsage({ prompt_tokens: 10, total_tokens: 12 });
  runtime.finish('failed', 'loop');
  const report = runtime.toJSON();
  assert.equal(report.state, 'failed');
  assert.equal(report.toolCalls, 2);
  assert.equal(report.usage.prompt_tokens, 10);
  assert.equal(toolSignature('x', { b: 1, a: 2 }), toolSignature('x', { a: 2, b: 1 }));
});

test('coding agent dry-run validates but does not mutate files or launch commands', async () => {
  const root = tmpdir();
  const config = agentCore.loadProjectConfig(root);
  config.permissionMode = 'full';
  const target = path.join(root, 'planned.txt');
  const transaction = { before() { throw new Error('must not mutate'); }, after() {}, audit() {} };
  const write = await agentInternals.executeTool('write_file', { path: 'planned.txt', content: 'future' }, { root, config, transaction, dryRun: true });
  const command = await agentInternals.executeTool('run_command', { program: 'node', args: ['--version'] }, { root, config, transaction, dryRun: true });
  assert.equal(write.dry_run, true);
  assert.equal(command.dry_run, true);
  assert.equal(fs.existsSync(target), false);
});

test('coding agent parses project-map output flags', () => {
  const args = agentInternals.parseArgs(['--project-map', '--json']);
  assert.equal(args.projectMap, true);
  assert.equal(args.json, true);
});

test('coding agent parses an explicit new conversation request', () => {
  assert.equal(agentInternals.parseArgs(['--new-session']).newSession, true);
});

test('coding agent supports a non-persistent history invocation', () => {
  const options = agentInternals.parseArgs(['--no-history', 'private task']);
  assert.equal(options.noHistory, true);
  assert.equal(options.prompt, 'private task');
});

test('coding agent rejects missing option values and stops parsing after double dash', () => {
  assert.throws(() => agentInternals.parseArgs(['--workspace']), /требуется значение/i);
  assert.throws(() => agentInternals.parseArgs(['--max-steps']), /требуется значение/i);
  const args = agentInternals.parseArgs(['--', '--yes']);
  assert.equal(args.yes, false);
  assert.equal(args.prompt, '--yes');
});

test('coding agent recognizes the user home directory as an unsafe default workspace', () => {
  assert.equal(agentInternals.isHomeWorkspace(os.homedir()), true);
  assert.equal(agentInternals.isHomeWorkspace(ROOT), false);
  assert.equal(agentInternals.parseArgs(['--allow-home']).allowHome, true);
});

test('coding agent model menu accepts a number or keeps the current model', async () => {
  const models = [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner', capabilities: { reasoning: true } }];
  const selected = await agentInternals.selectModel({ question: async () => '2' }, models, 'deepseek-chat');
  const unchanged = await agentInternals.selectModel({ question: async () => '' }, models, 'deepseek-chat');
  assert.equal(selected, 'deepseek-reasoner');
  assert.equal(unchanged, 'deepseek-chat');
});

test('coding agent protects secrets and rejects unsafe command paths', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
  const config = agentCore.loadProjectConfig(root);
  assert.equal(agentCore.isProtectedPath(root, path.join(root, '.env')), true);
  assert.throws(() => agentCore.assertAccessible(root, path.join(root, '.env'), config), /защищённый путь/i);
  assert.throws(() => agentCore.validateCommand('powershell', [], root, config), /не разрешена/i);
  assert.throws(() => agentCore.validateCommand(path.join(root, 'node'), [], root, config), /имя программы без пути/i);
  assert.throws(() => agentCore.validateCommand('node', ['../outside.js'], root, config), /выходом из рабочей папки/i);
  assert.equal(agentCore.validateCommand('npm', ['test'], root, config), 'npm');
});

test('repository config cannot silently elevate agent privileges', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.deepseek-agent.json'), JSON.stringify({
    permissionMode: 'full',
    allowProtectedPaths: true,
    maxFileBytes: 999999999,
    allowedPrograms: ['node', 'powershell', 'made-up-program'],
  }));
  const config = agentCore.loadProjectConfig(root);
  assert.equal(config.permissionMode, 'ask');
  assert.equal(config.allowProtectedPaths, false);
  assert.equal(config.maxFileBytes, 10 * 1024 * 1024);
  assert.deepEqual(config.allowedPrograms, ['node']);
});

test('coding agent strips common secret environment variables', () => {
  const env = agentCore.sanitizeEnvironment({
    PATH: 'safe-path',
    HOME: 'safe-home',
    FREEDEEPSEEK_API_KEY: 'secret',
    AWS_ACCESS_KEY_ID: 'secret',
    ORDINARY_VALUE: 'not-forwarded',
  });
  assert.equal(env.PATH, 'safe-path');
  assert.equal(env.HOME, 'safe-home');
  assert.equal(env.FREEDEEPSEEK_API_KEY, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.ORDINARY_VALUE, 'not-forwarded');
});

test('coding agent builds a resource-limited networkless Docker invocation', () => {
  const root = tmpdir();
  const invocation = agentCore.buildCommandInvocation('npm', ['test'], {
    cwd: root,
    sandbox: 'docker',
    dockerImage: 'node:22-alpine',
    sandboxMemoryMb: 384,
    sandboxCpu: 0.5,
    sandboxNetwork: false,
  });
  assert.equal(invocation.executable, 'docker');
  assert.deepEqual(invocation.args.slice(0, 13), [
    'run', '--rm', '--init', '--network', 'none', '--cpus', '0.5', '--memory', '384m',
    '--pids-limit', '128', '--cap-drop', 'ALL',
  ]);
  assert.ok(invocation.args.includes('no-new-privileges'));
  assert.deepEqual(invocation.args.slice(-3), ['node:22-alpine', 'npm', 'test']);
});

test('coding agent validates sandbox configuration bounds', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.deepseek-agent.json'), JSON.stringify({
    commandSandbox: 'docker', dockerImage: 'node:22-alpine', sandboxMemoryMb: 16, sandboxCpu: 100,
  }));
  const config = agentCore.loadProjectConfig(root);
  assert.equal(config.commandSandbox, 'docker');
  assert.equal(config.sandboxMemoryMb, 128);
  assert.equal(config.sandboxCpu, 8);
  fs.writeFileSync(path.join(root, '.deepseek-agent.json'), JSON.stringify({ commandSandbox: 'unknown' }));
  assert.throws(() => agentCore.loadProjectConfig(root), /commandSandbox/);
});

test('coding agent transaction can undo file creation and modification', () => {
  const root = tmpdir();
  const existing = path.join(root, 'existing.txt');
  const created = path.join(root, 'created.txt');
  fs.writeFileSync(existing, 'before');
  const tx = new agentCore.RunTransaction(root, 'test transaction');
  tx.before(existing);
  agentCore.atomicWrite(existing, 'after');
  tx.after(existing);
  tx.before(created);
  agentCore.atomicWrite(created, 'new');
  tx.after(created);
  tx.finish('completed');
  const result = agentCore.undoLatestRun(root);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'before');
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual(result.restored.sort(), ['created.txt', 'existing.txt']);
});

test('coding agent keeps bounded conversation context per workspace', () => {
  const first = tmpdir();
  const second = tmpdir();
  assert.equal(agentCore.workspaceSessionId(first), agentCore.workspaceSessionId(first));
  assert.notEqual(agentCore.workspaceSessionId(first), agentCore.workspaceSessionId(second));
  for (let i = 0; i < 14; i++) agentCore.saveConversationExchange(first, `request ${i}`, `result ${i}`);
  const history = agentCore.loadConversation(first);
  assert.equal(history.length, 12);
  assert.equal(history[0].user, 'request 2');
  assert.equal(history.at(-1).assistant, 'result 13');
  agentCore.clearConversation(first);
  assert.deepEqual(agentCore.loadConversation(first), []);
});

test('coding agent can disable, expire and tighten saved conversation history', () => {
  const root = tmpdir();
  assert.deepEqual(agentCore.saveConversationExchange(root, 'secret', 'answer', { historyEnabled: false }), []);
  assert.equal(fs.existsSync(path.join(root, '.deepseek-agent', 'conversation.json')), false);
  agentCore.saveConversationExchange(root, 'old', 'answer');
  const file = path.join(root, '.deepseek-agent', 'conversation.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.exchanges[0].at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(agentCore.loadConversation(root, { historyTtlDays: 1 }), []);
  for (let i = 0; i < 5; i++) agentCore.saveConversationExchange(root, `request ${i}`, `answer ${i}`, { maxConversationExchanges: 2 });
  assert.equal(agentCore.loadConversation(root).length, 2);
});

test('coding agent can recover mutations from a failed run', () => {
  const root = tmpdir();
  const file = path.join(root, 'partial.txt');
  const tx = new agentCore.RunTransaction(root, 'failing task');
  tx.before(file);
  agentCore.atomicWrite(file, 'partial result');
  tx.after(file);
  tx.finish('failed', 'simulated failure');
  const result = agentCore.undoLatestRun(root);
  assert.equal(result.runId, tx.id);
  assert.equal(fs.existsSync(file), false);
});

test('coding agent cancellation rolls its own transaction back', () => {
  const root = tmpdir();
  const file = path.join(root, 'cancelled.txt');
  const tx = new agentCore.RunTransaction(root, 'cancelled task');
  tx.before(file);
  agentCore.atomicWrite(file, 'partial result');
  tx.after(file);
  const result = tx.rollback('cancelled');
  assert.equal(result.runId, tx.id);
  assert.equal(fs.existsSync(file), false);
  const manifest = JSON.parse(fs.readFileSync(tx.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'cancelled');
});

test('coding agent runs an allowed executable without a shell', async () => {
  const root = tmpdir();
  const result = await agentCore.runProgram(process.execPath, ['--version'], {
    cwd: root,
    timeoutMs: 5000,
    maxOutputBytes: 10000,
    env: agentCore.sanitizeEnvironment(),
  });
  assert.equal(result.exit_code, 0, result.stderr || result.error);
  assert.match(result.stdout, /^v\d+/);
});

test('coding agent runs npm without a shell on Windows', async () => {
  const result = await agentCore.runProgram('npm', ['--version'], {
    cwd: ROOT,
    timeoutMs: 10000,
    maxOutputBytes: 10000,
    env: agentCore.sanitizeEnvironment(),
  });
  assert.equal(result.exit_code, 0, result.stderr || result.error);
  assert.match(result.stdout.trim(), /^\d+\.\d+/);
});

test('project index maps the full workspace while excluding secrets and dependencies', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(root, 'tests', 'app.test.js'), 'test("ok", () => {});');
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'indexed-project', scripts: { test: 'node --test' } }));
  const index = projectIndex.createProjectIndex(root, agentCore.loadProjectConfig(root));
  assert.deepEqual(index.files.map(file => file.path), ['package.json', 'src/app.js', 'tests/app.test.js']);
  assert.equal(index.testFileCount, 1);
  assert.equal(index.package.name, 'indexed-project');
  assert.match(projectIndex.formatProjectContext(index), /src\/app\.js/);
  assert.equal(projectIndex.projectMapPage(index, { query: 'tests' }).totalMatched, 1);
});

test('project index reports truncation only when more files exist', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b');
  const exact = projectIndex.createProjectIndex(root, agentCore.loadProjectConfig(root), { limit: 100 });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(root, `file-${i}.txt`), String(i));
  const limited = projectIndex.createProjectIndex(root, agentCore.loadProjectConfig(root), { limit: 100 });
  assert.equal(exact.truncated, false);
  assert.equal(limited.truncated, true);
});

test('Studio parses a fixed workspace and validates its local port', () => {
  const root = tmpdir();
  const options = studio.parseArgs(['-C', root, '--port', '9777']);
  assert.equal(options.workspace, path.resolve(root));
  assert.equal(options.port, 9777);
  assert.throws(() => studio.parseArgs(['--port', '80']), /Некорректный --port/);
  assert.throws(() => studio.parseArgs(['--unknown']), /Неизвестный параметр/);
  assert.throws(() => studio.parseArgs(['--workspace']), /требуется значение/i);
});

test('Studio refuses directories and binary files in the text viewer', () => {
  const root = tmpdir();
  const binary = path.join(root, 'image.bin');
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  assert.throws(() => studio.readStudioFile(root, 1024), /не является файлом/i);
  assert.match(studio.readStudioFile(binary, 1024), /бинарный файл/i);
});

test('stream responses do not bypass the configured CORS policy', () => {
  const headers = serverInternals.streamHeaders();
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(headers['Content-Type'], 'text/event-stream');
});

test('Studio rejects DNS rebinding and cross-site mutation requests', () => {
  studio.assertLocalRequest({ method: 'GET', headers: { host: '127.0.0.1:9660' } }, 9660);
  studio.assertLocalRequest({ method: 'POST', headers: { host: 'localhost:9660', origin: 'http://localhost:9660', 'sec-fetch-site': 'same-origin' } }, 9660);
  assert.throws(() => studio.assertLocalRequest({ method: 'GET', headers: { host: 'attacker.test:9660' } }, 9660), /Host/);
  assert.throws(() => studio.assertLocalRequest({ method: 'POST', headers: { host: '127.0.0.1:9660', origin: 'https://attacker.test' } }, 9660), /Origin/);
  assert.throws(() => studio.assertLocalRequest({ method: 'POST', headers: { host: '127.0.0.1:9660', 'sec-fetch-site': 'cross-site' } }, 9660), /Cross-site/);
});

test('Studio builds a transaction diff without exposing full unchanged files', () => {
  const root = tmpdir();
  const file = path.join(root, 'sample.txt');
  fs.writeFileSync(file, 'same\nbefore\ntail\n');
  const tx = new agentCore.RunTransaction(root, 'diff test');
  tx.before(file);
  agentCore.atomicWrite(file, 'same\nafter\ntail\n');
  tx.after(file);
  tx.finish('completed');
  const runs = studio.loadRuns(root);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].diffs[0], {
    path: 'sample.txt',
    startLine: 2,
    removed: ['before'],
    added: ['after'],
  });
});
