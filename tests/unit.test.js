const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../server.js').__test;
const clientModule = require('../client.js');
const clientInternals = clientModule.__test;
const clientApi = clientModule.api;
const agentInternals = require('../agent.js').__test;
const agentCore = require('../lib/agent-core.js');
const { ToolRegistry, createCodingToolRegistry } = require('../lib/tool-registry.js');
const { AgentRunController, toolSignature } = require('../lib/agent-runtime.js');
const projectMemory = require('../lib/project-memory.js');
const taskPlan = require('../lib/task-plan.js');
const projectIndex = require('../lib/project-index.js');
const studio = require('../studio-server.js');
const { loadServerConfig } = require('../lib/server-config.js');
const { createSessionStore } = require('../lib/session-store.js');
const { createHttpGuard } = require('../lib/http-guard.js');
const apiRoutes = require('../lib/api-routes.js');
const { createLogger, redact, attachRequestLog } = require('../lib/logger.js');
const { EventEmitter } = require('node:events');
const gitService = require('../lib/git-service.js');
const projectRegistry = require('../lib/project-registry.js');
const doctor = require('../scripts/doctor.js');
const chromeAuthScript = path.join(ROOT, 'scripts/deepseek_chrome_auth.js');

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

function mockJsonResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
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

test('API route helpers return health and control responses', () => {
  const store = createSessionStore();
  store.store('agent-a', 'hello', 'world');
  const context = {
    watermark: 'test-watermark',
    modelConfigs: {
      'deepseek-chat': { supported: true, real_model: 'web-chat', capabilities: { files: true } },
      'deepseek-vision': { supported: false, real_model: 'vision', capabilities: { vision: true } },
    },
    supportedModelIds: ['deepseek-chat'],
    allModelCapabilities: { 'deepseek-chat': { supported: true } },
    sessions: store.sessions,
    accounts: [{ id: 'a1' }],
    accountStatus: account => ({ id: account.id, ready: true }),
    hasAuthConfig: () => true,
    sessionTtlMs: 120000,
    maxMessageDepth: 10,
    sessionStore: store,
  };

  const health = mockJsonResponse();
  assert.equal(apiRoutes.handleHealthRoute({ method: 'GET' }, health, new URL('http://local/health'), context), true);
  assert.equal(health.status, 200);
  assert.equal(health.headers['Content-Type'], 'application/json');
  assert.deepEqual(health.json().unsupported_models, ['deepseek-vision']);
  assert.equal(health.json().session_reuse.ttl_minutes, 2);

  const models = mockJsonResponse();
  assert.equal(apiRoutes.handleControlRoutes({ method: 'GET' }, models, new URL('http://local/v1/models'), context), true);
  assert.equal(models.json().data[0].real_model, 'web-chat');

  const capabilities = mockJsonResponse();
  assert.equal(apiRoutes.handleControlRoutes({ method: 'GET' }, capabilities, new URL('http://local/api/model-capabilities'), context), true);
  assert.equal(capabilities.json().data['deepseek-chat'].supported, true);

  const sessions = mockJsonResponse();
  assert.equal(apiRoutes.handleControlRoutes({ method: 'GET' }, sessions, new URL('http://local/v1/sessions'), context), true);
  assert.equal(sessions.json().total, 1);

  const missing = mockJsonResponse();
  assert.equal(apiRoutes.handleControlRoutes({ method: 'POST' }, missing, new URL('http://local/reset-session?agent=missing'), context), true);
  assert.equal(missing.status, 404);

  const reset = mockJsonResponse();
  assert.equal(apiRoutes.handleControlRoutes({ method: 'POST' }, reset, new URL('http://local/reset-session?agent=agent-a&clear_history=true'), context), true);
  assert.equal(reset.json().status, 'session_reset');
  assert.equal(reset.json().history_preserved, 0);

  store.store('agent-b', 'hello', 'again');
  const resetAll = mockJsonResponse();
  assert.equal(apiRoutes.handleControlRoutes({ method: 'POST' }, resetAll, new URL('http://local/reset-session?agent=all'), context), true);
  assert.equal(resetAll.json().status, 'all_sessions_cleared');

  assert.equal(apiRoutes.handleHealthRoute({ method: 'POST' }, mockJsonResponse(), new URL('http://local/health'), context), false);
  assert.equal(apiRoutes.handleControlRoutes({ method: 'GET' }, mockJsonResponse(), new URL('http://local/missing'), context), false);
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

test('doctor helpers discover auth files and report invalid JSON', () => {
  const originalAuthDir = process.env.DEEPSEEK_AUTH_DIR;
  const originalAuthPath = process.env.DEEPSEEK_AUTH_PATH;
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'b.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), '{}');
    process.env.DEEPSEEK_AUTH_DIR = dir;
    delete process.env.DEEPSEEK_AUTH_PATH;
    assert.deepEqual(doctor.authPaths().map(file => path.basename(file)), ['a.json', 'b.json']);

    process.env.DEEPSEEK_AUTH_DIR = path.join(dir, 'missing');
    assert.deepEqual(doctor.authPaths(), [path.join(dir, 'missing', '(directory unavailable)')]);

    delete process.env.DEEPSEEK_AUTH_DIR;
    process.env.DEEPSEEK_AUTH_PATH = `${path.join(dir, 'one.json')}, ${path.join(dir, 'two.json')}`;
    assert.deepEqual(doctor.authPaths(), [path.join(dir, 'one.json'), path.join(dir, 'two.json')]);

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{broken');
    const result = doctor.checkAuthFile(broken);
    assert.equal(result.ok, false);
    assert.match(result.issues[0], /invalid JSON/);
  } finally {
    if (originalAuthDir === undefined) delete process.env.DEEPSEEK_AUTH_DIR;
    else process.env.DEEPSEEK_AUTH_DIR = originalAuthDir;
    if (originalAuthPath === undefined) delete process.env.DEEPSEEK_AUTH_PATH;
    else process.env.DEEPSEEK_AUTH_PATH = originalAuthPath;
  }
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

test('chrome auth helper can be imported without launching Chrome and validates pure helpers', () => {
  const res = runNode(['-e', `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const helper = require(${JSON.stringify(chromeAuthScript)});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-profile-test-'));
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'x');
    const parsed = helper.normalizeToken(JSON.stringify({ accessToken: 'tok_123' }));
    const raw = helper.normalizeToken(' raw-token ');
    const help = helper.chromeInstallHelp('missing-browser');
    helper.removeProfileSafely(dir);
    let unsafe = false;
    try { helper.removeProfileSafely(os.homedir()); } catch { unsafe = true; }
    console.log(JSON.stringify({
      parsed, raw, hasHelp: /Windows[\\s\\S]*macOS[\\s\\S]*Linux/.test(help),
      removed: !fs.existsSync(dir), unsafe
    }));
  `], { env: { CHROME_PATH: path.join(tmpdir(), 'missing-chrome') } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const result = JSON.parse(res.stdout.trim());
  assert.deepEqual(result, {
    parsed: 'tok_123',
    raw: 'raw-token',
    hasHelp: true,
    removed: true,
    unsafe: true,
  });
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

test('server helper functions normalize tool calls, content and compatibility payloads', () => {
  assert.equal(serverInternals.parseRetryAfterMs('2'), 2000);
  assert.equal(serverInternals.parseRetryAfterMs('not-a-date'), null);
  assert.equal(serverInternals.extractBalancedJsonAt('x {"a":{"b":"}"},"c":1} tail', 2), '{"a":{"b":"}"},"c":1}');
  assert.deepEqual(serverInternals.coerceToolCallObject({ function: { name: 'run', arguments: '{"ok":true}' } }), {
    name: 'run',
    arguments: '{"ok":true}',
  });
  assert.deepEqual(serverInternals.parseToolCall('```json\n{"tool_call":{"name":"read_file","arguments":{"path":"README.md"}}}\n```'), {
    name: 'read_file',
    arguments: '{"path":"README.md"}',
  });
  assert.deepEqual(serverInternals.parseToolCall('TOOL_CALL: list_files\narguments: {"path":"."}'), {
    name: 'list_files',
    arguments: '{"path":"."}',
  });
  assert.equal(serverInternals.parseToolCall('no tools here'), null);
  assert.match(serverInternals.formatToolDefinitions([{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }]), /read_file/);
  assert.equal(serverInternals.formatToolDefinitions([]), '');
  assert.equal(serverInternals.sanitizeContent('a\ud800b'), 'ab');
  assert.deepEqual(serverInternals.buildUsage('12345', 'abcd', 'abcdefgh').completion_tokens_details, { reasoning_tokens: 2 });

  const textResponse = serverInternals.buildTextResponse('answer', 'prompt', 'deepseek-chat', 'think');
  assert.equal(textResponse.choices[0].message.reasoning_content, 'think');
  const toolResponse = serverInternals.buildToolCallResponse({ name: 'read_file', arguments: '{"path":"a"}' }, 'deepseek-chat', 'prompt', 'think');
  assert.equal(toolResponse.choices[0].finish_reason, 'tool_calls');
  assert.equal(toolResponse.choices[0].message.content, null);

  assert.equal(serverInternals.normalizeMessageContent([
    { type: 'text', text: 'hello' },
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'done' }] },
    { type: 'image_url', image_url: { url: 'file.png' } },
  ]), 'hello\n[Tool Result toolu_1]\ndone\n[Image: file.png]');

  assert.deepEqual(serverInternals.normalizeAnthropicTools([{ name: 'lookup', input_schema: { type: 'object' } }])[0].function.name, 'lookup');
  assert.deepEqual(serverInternals.normalizeResponsesTools([{ type: 'function', name: 'lookup', parameters: { type: 'object' } }])[0].function.name, 'lookup');
  assert.deepEqual(serverInternals.normalizeResponsesInput([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ]), [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ]);

  const anthropic = serverInternals.normalizeApiParams({
    system: 'sys',
    metadata: { user_id: 'user-1' },
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  }, 'anthropic');
  assert.equal(anthropic.model, 'deepseek-chat');
  assert.equal(anthropic.user, 'user-1');
  assert.equal(anthropic.messages[1].tool_calls[0].function.name, 'lookup');
  assert.equal(anthropic.messages[2].role, 'tool');

  const responses = serverInternals.normalizeApiParams({
    instructions: 'sys',
    input: 'hello',
    tools: [{ type: 'function', name: 'lookup' }],
    stream: true,
  }, 'responses');
  assert.deepEqual(responses.messages.slice(0, 2), [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]);
  assert.equal(responses.stream, true);
  assert.deepEqual(serverInternals.safeJsonParseObject('[]', { fallback: true }), { fallback: true });

  const anthropicToolResponse = serverInternals.toAnthropicResponse(toolResponse);
  assert.equal(anthropicToolResponse.content[0].type, 'tool_use');
  const anthropicTextResponse = serverInternals.toAnthropicResponse(textResponse);
  assert.equal(anthropicTextResponse.content[0].text, 'answer');
  assert.equal(anthropicTextResponse.reasoning_content, 'think');
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

test('CLI API wrapper injects API keys and normalizes fetch errors', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.FREEDEEPSEEK_API_KEY;
  const calls = [];
  try {
    process.env.FREEDEEPSEEK_API_KEY = 'test-key';
    global.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { data: [{ id: 'z-model' }, { id: 'deepseek-chat' }] };
        },
      };
    };
    const models = await clientApi.connectModels({ url: 'http://api.test', autoStart: false });
    assert.deepEqual(models.map(model => model.id), ['deepseek-chat', 'z-model']);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');

    global.fetch = async () => ({
      ok: false,
      status: 400,
      async text() {
        return JSON.stringify({ error: { message: 'bad request' } });
      },
    });
    await assert.rejects(() => clientApi.request('http://api.test/fail'), /bad request \(HTTP 400\)/);

    global.fetch = async () => { throw new Error('socket closed'); };
    await assert.rejects(() => clientApi.request('http://api.test/down'), error => {
      assert.equal(error.code, 'API_UNREACHABLE');
      assert.match(error.message, /socket closed/);
      return true;
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FREEDEEPSEEK_API_KEY;
    else process.env.FREEDEEPSEEK_API_KEY = originalKey;
  }
});

test('CLI streaming reader returns reasoning and content from SSE chunks', async () => {
  const encoder = new TextEncoder();
  const response = {
    body: [
      encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n'),
      encoder.encode('data: [DONE]\n'),
    ],
  };
  let printed = '';
  const result = await clientInternals.readStreamingResponse(response, { write: chunk => { printed += chunk; } });
  assert.deepEqual(result, { content: 'answer', reasoning: 'think' });
  assert.match(printed, /think/);
  assert.match(printed, /answer/);
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

test('coding agent helper functions format capabilities and inspect files safely', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log("ok");');
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, 'large.txt'), '12345');

  assert.equal(agentInternals.relativePath(root, root), '.');
  assert.equal(agentInternals.relativePath(root, path.join(root, 'src', 'app.js')), path.join('src', 'app.js'));
  assert.equal(agentInternals.capabilityBadges({ capabilities: { reasoning: true, web_search: true, files: true } }), 'reasoning, search, files');
  assert.equal(agentInternals.capabilityBadges({ capabilities: {} }), 'chat');
  assert.deepEqual(agentInternals.walk(root, root, 3, 20), ['binary.bin', 'large.txt', 'src/', path.join('src', 'app.js')]);
  assert.equal(agentInternals.readTextFile(path.join(root, 'src', 'app.js')), 'console.log("ok");');
  assert.throws(() => agentInternals.readTextFile(root), /не файл/i);
  assert.throws(() => agentInternals.readTextFile(path.join(root, 'binary.bin')), /Бинарный файл/i);
  assert.throws(() => agentInternals.readTextFile(path.join(root, 'large.txt'), 4), /слишком большой/i);
});

test('tool registry exposes provider schemas and permission kinds', () => {
  const registry = createCodingToolRegistry();
  assert.equal(registry.names().length, 14);
  assert.equal(registry.kind('read_file'), 'read');
  assert.equal(registry.kind('write_file'), 'write');
  assert.equal(registry.kind('run_command'), 'command');
  assert.equal(registry.schemas()[0].kind, undefined);
  assert.equal(registry.describe().find(tool => tool.name === 'run_command').kind, 'command');
  assert.throws(() => registry.validate('read_file', {}), /path.*обязателен/i);
  assert.throws(() => registry.validate('update_task', { id: 'A', state: 'unknown' }), /неподдерживаемое/i);
  assert.deepEqual(registry.validate('read_file', { path: 'README.md' }), { path: 'README.md' });
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

test('agent runtime enforces cancellation and wall-clock budgets with metrics', () => {
  let now = 1000;
  const runtime = new AgentRunController({ maxDurationMs: 1000, clock: () => now });
  runtime.start();
  runtime.beginStep();
  runtime.acceptToolCall('read_file', { path: 'a.js' });
  runtime.recordToolResult('read_file', { path: 'a.js' }, { ok: false, denied: true }, 'read');
  assert.equal(runtime.remainingTimeMs(), 1000);
  now = 2000;
  assert.equal(runtime.remainingTimeMs(), 0);
  assert.throws(() => runtime.beginStep(), error => error.code === 'DURATION_LIMIT' && /разбейте задачу/i.test(error.recovery));
  runtime.finish('failed', 'duration');
  assert.deepEqual(runtime.toJSON().metrics, {
    durationMs: 1000, failedToolCalls: 1, deniedToolCalls: 1,
    toolCallsByKind: { read: 1, write: 0, command: 0 },
  });
  const cancelled = new AgentRunController();
  cancelled.start();
  assert.throws(() => cancelled.beginStep({ aborted: true }), error => error.code === 'RUN_CANCELLED');
});

test('agent runtime produces an abort signal for in-flight API deadlines', async () => {
  const runtime = new AgentRunController({ maxDurationMs: 1000 });
  runtime.start();
  const signal = runtime.createDeadlineSignal();
  assert.equal(signal.aborted, false);
  assert.ok(runtime.remainingTimeMs() <= 1000);
});

test('task plan validates dependencies, transitions and optimistic revisions', () => {
  const root = tmpdir();
  const plan = taskPlan.saveTaskPlan(root, {
    goal: 'Ship safely',
    tasks: [
      { id: 'inspect', title: 'Inspect project' },
      { id: 'change', title: 'Make change', dependsOn: ['inspect'] },
    ],
  }, { expectedRevision: 0 });
  assert.equal(plan.revision, 1);
  assert.deepEqual(taskPlan.readyTasks(plan).map(task => task.id), ['inspect']);
  assert.throws(() => taskPlan.updateTask(root, 'change', 'in_progress'), /зависимост/i);
  taskPlan.updateTask(root, 'inspect', 'in_progress');
  const completed = taskPlan.updateTask(root, 'inspect', 'completed');
  assert.deepEqual(completed.ready.map(task => task.id), ['change']);
  assert.equal(completed.progress.percent, 50);
  assert.throws(() => taskPlan.updateTask(root, 'change', 'in_progress', '', { expectedRevision: 1 }), /конфликт версии/i);
  assert.throws(() => taskPlan.normalizePlan({ tasks: [
    { id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] },
  ] }), /циклическая/i);
});

test('task-plan tools respect dry-run and transaction rollback', async () => {
  const root = tmpdir();
  const config = agentCore.loadProjectConfig(root);
  config.permissionMode = 'full';
  const transaction = new agentCore.RunTransaction(root, 'plan rollback');
  const args = { goal: 'Test', tasks: [{ id: 'one', title: 'First' }] };
  const preview = await agentInternals.executeTool('set_task_plan', args, { root, config, transaction, dryRun: true });
  assert.equal(preview.dry_run, true);
  assert.equal(taskPlan.loadTaskPlan(root), null);
  const saved = await agentInternals.executeTool('set_task_plan', args, { root, config, transaction });
  assert.equal(saved.progress.total, 1);
  transaction.finish('failed', 'simulated');
  transaction.rollback('undone');
  assert.equal(taskPlan.loadTaskPlan(root), null);
});

test('project memory detects corruption and revision conflicts', () => {
  const root = tmpdir();
  projectMemory.rememberProjectMemory(root, { key: 'rule', value: 'Test before release', type: 'constraint' });
  assert.equal(projectMemory.memoryStats(root).revision, 1);
  assert.throws(() => projectMemory.rememberProjectMemory(root, { key: 'next', value: 'Ship', type: 'todo' }, { expectedRevision: 0 }), /конфликт версии/i);
  fs.writeFileSync(projectMemory.memoryPath(root), '{broken');
  assert.throws(() => projectMemory.loadProjectMemory(root), /некорректная память/i);
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

test('coding agent file tools cover list, read, search, replace and delete dry-run paths', async () => {
  const root = tmpdir();
  const config = agentCore.loadProjectConfig(root);
  config.permissionMode = 'full';
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'alpha\nbeta\nalpha\n');
  const context = { root, config, transaction: { before() {}, after() {}, audit() {} }, dryRun: true };

  const listed = await agentInternals.executeTool('list_files', { path: '.', depth: 2 }, context);
  assert.equal(listed.path, '.');
  assert.ok(listed.entries.includes('src/'));
  assert.ok(listed.entries.includes(path.join('src', 'app.js')));

  const read = await agentInternals.executeTool('read_file', { path: 'src/app.js', start_line: 2, end_line: 2 }, context);
  assert.equal(read.content, '2: beta');

  const found = await agentInternals.executeTool('search_files', { path: 'src', query: 'ALPHA' }, context);
  assert.equal(found.matches.length, 2);
  const foundCaseSensitive = await agentInternals.executeTool('search_files', { path: 'src', query: 'ALPHA', case_sensitive: true }, context);
  assert.deepEqual(foundCaseSensitive.matches, []);
  await assert.rejects(() => agentInternals.executeTool('search_files', { path: 'src', query: '' }, context), /Пустая строка поиска/);

  await assert.rejects(() => agentInternals.executeTool('replace_in_file', { path: 'src/app.js', old_text: '', new_text: 'x' }, context), /old_text/);
  await assert.rejects(() => agentInternals.executeTool('replace_in_file', { path: 'src/app.js', old_text: 'missing', new_text: 'x' }, context), /не найден/);
  await assert.rejects(() => agentInternals.executeTool('replace_in_file', { path: 'src/app.js', old_text: 'alpha', new_text: 'gamma' }, context), /найден 2 раз/);
  const replace = await agentInternals.executeTool('replace_in_file', { path: 'src/app.js', old_text: 'alpha', new_text: 'gamma', replace_all: true }, context);
  assert.deepEqual({ dry_run: replace.dry_run, action: replace.action, replacements: replace.replacements }, { dry_run: true, action: 'replace', replacements: 2 });

  await assert.rejects(() => agentInternals.executeTool('delete_path', { path: 'missing.txt' }, context), /Путь не существует/);
  await assert.rejects(() => agentInternals.executeTool('delete_path', { path: 'src' }, context), /recursive=true/);
  const deleted = await agentInternals.executeTool('delete_path', { path: 'src', recursive: true }, context);
  assert.deepEqual({ dry_run: deleted.dry_run, action: deleted.action, recursive: deleted.recursive }, { dry_run: true, action: 'delete', recursive: true });
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

test('coding agent ranks relevant conversation within a strict context budget', () => {
  const exchanges = [
    { user: 'Discuss CSS colors', assistant: 'Use blue and green' },
    { user: 'Fix authentication token refresh', assistant: 'The refresh code is in auth.js' },
    { user: 'Unrelated release note', assistant: 'Update changelog' },
  ];
  const selected = agentCore.selectConversationContext(exchanges, 'Continue authentication refresh', 1000);
  assert.deepEqual(selected, exchanges);
  const tight = agentCore.selectConversationContext(exchanges, 'Continue authentication refresh', 80);
  assert.deepEqual(tight.map(item => item.user), ['Fix authentication token refresh']);
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
