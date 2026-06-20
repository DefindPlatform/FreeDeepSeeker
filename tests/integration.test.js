const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const ROOT = path.resolve(__dirname, '..');
const { createStudioServer } = require('../studio-server.js');
const projectMemory = require('../lib/project-memory.js');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function startServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-integration-'));
  const authPath = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    token: 'integration-token',
    cookie: 'integration_cookie=placeholder',
    wasmUrl: 'https://example.invalid/pow.wasm',
  }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NON_INTERACTIVE: '1',
      SKIP_ACCOUNT_MENU: '1',
      DEEPSEEK_AUTH_PATH: authPath,
      FREEDEEPSEEK_API_KEY: 'integration-key',
      RATE_LIMIT_PER_MINUTE: '100',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timeout:\n${output}`)), 10000);
    const poll = setInterval(() => {
      if (output.includes('[DS-API] Server on')) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      } else if (child.exitCode !== null) {
        clearTimeout(timeout);
        clearInterval(poll);
        reject(new Error(`Server exited during startup (${child.exitCode}):\n${output}`));
      }
    }, 25);
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { Authorization: 'Bearer integration-key' },
    async stop() {
      if (child.exitCode === null) child.kill();
      await new Promise(resolve => child.once('exit', resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('HTTP server enforces auth and exposes documented read endpoints', async t => {
  const app = await startServer();
  t.after(() => app.stop());
  const unauthorized = await fetch(`${app.baseUrl}/health`);
  assert.equal(unauthorized.status, 401);
  const health = await fetch(`${app.baseUrl}/health`, { headers: app.headers });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).config_ready, true);
  const models = await fetch(`${app.baseUrl}/v1/models`, { headers: app.headers });
  const modelBody = await models.json();
  assert.equal(models.status, 200);
  assert.ok(modelBody.data.some(model => model.id === 'deepseek-chat'));
  const capabilities = await fetch(`${app.baseUrl}/api/model-capabilities`, { headers: app.headers });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).data['deepseek-chat'].supported, true);
});

test('HTTP server returns stable client errors without contacting DeepSeek', async t => {
  const app = await startServer({ MAX_REQUEST_BYTES: '1024' });
  t.after(() => app.stop());
  const headers = { ...app.headers, 'Content-Type': 'application/json' };
  const invalid = await fetch(`${app.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: '{broken' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.type, 'invalid_request_error');
  const unknownModel = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'missing-model', messages: [] }),
  });
  assert.equal(unknownModel.status, 400);
  assert.equal((await unknownModel.json()).error.type, 'invalid_model');
  const tooLarge = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(2000) }] }),
  });
  assert.equal(tooLarge.status, 413);
  const missing = await fetch(`${app.baseUrl}/not-found`, { headers: app.headers });
  assert.equal(missing.status, 404);
});

test('health checks bypass rate limiting while API routes do not', async t => {
  const app = await startServer({ RATE_LIMIT_PER_MINUTE: '2' });
  t.after(() => app.stop());
  for (let i = 0; i < 4; i++) assert.equal((await fetch(`${app.baseUrl}/health`, { headers: app.headers })).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/v1/models`, { headers: app.headers })).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/v1/sessions`, { headers: app.headers })).status, 200);
  const limited = await fetch(`${app.baseUrl}/v1/models`, { headers: app.headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('Studio streams events and cancels an active agent task', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-studio-'));
  const secondWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-studio-second-'));
  const registryFile = path.join(workspace, 'studio-projects.json');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(secondWorkspace, 'SECOND.md'), '# second\n');
  const port = await freePort();
  let child;
  const spawnAgent = () => {
    child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    return child;
  };
  const server = createStudioServer({ workspace, port, spawnAgent, registryFile });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(secondWorkspace, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const events = await fetch(`${baseUrl}/api/events`);
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /"type":"connected"/);
  await reader.cancel();
  const started = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'wait', model: 'deepseek-chat', mode: 'read-only' }),
  });
  assert.equal(started.status, 202);
  child.stdout.write('working\n');
  const commitWhileRunning = await fetch(`${baseUrl}/api/git/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Race', confirmed: true }),
  });
  assert.equal(commitWhileRunning.status, 400);
  assert.match((await commitWhileRunning.json()).error, /во время выполнения задачи/);
  const cancelled = await fetch(`${baseUrl}/api/tasks/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const state = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  assert.equal(state.task.status, 'cancelled');
  assert.equal(state.task.lines[0].text, 'working');
  assert.equal((await fetch(`${baseUrl}/api/tasks/cancel`, { method: 'POST' })).status, 400);
  const switched = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: secondWorkspace }),
  });
  assert.equal(switched.status, 200);
  const switchedState = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  assert.equal(switchedState.workspace, fs.realpathSync(secondWorkspace));
  assert.equal(switchedState.projects.length, 2);
  assert.equal(switchedState.project.files[0].path, 'SECOND.md');
  projectMemory.rememberProjectMemory(secondWorkspace, { key: 'release-rule', value: 'Run all tests before push', type: 'constraint' });
  const memoryState = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  assert.equal(memoryState.memory.entries[0].key, 'release-rule');
  const unconfirmedForget = await fetch(`${baseUrl}/api/memory/forget`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'release-rule' }),
  });
  assert.equal(unconfirmedForget.status, 400);
  const forgotten = await fetch(`${baseUrl}/api/memory/forget`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'release-rule', confirmed: true }),
  });
  assert.equal(forgotten.status, 200);
  assert.equal((await forgotten.json()).deleted, true);
  const rejectedCommit = await fetch(`${baseUrl}/api/git/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'No confirmation' }),
  });
  assert.equal(rejectedCommit.status, 400);
});
