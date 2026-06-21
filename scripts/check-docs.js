#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const docFiles = [
  'README.md', 'SECURITY.md', 'CONTRIBUTING.md', '.env.example',
  'docs/api-documentation.md', 'docs/architecture.md', 'docs/coding-agent.md', 'docs/studio.md', 'docs/browser-auth.md',
];
const docs = Object.fromEntries(docFiles.map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
const allDocs = Object.values(docs).join('\n');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
  });
}

for (const file of [path.join(ROOT, 'README.md'), ...markdownFiles(path.join(ROOT, 'docs'))]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
    if (!href || /^(?:https?:|mailto:)/i.test(href)) continue;
    const target = path.resolve(path.dirname(file), decodeURIComponent(href));
    if (!fs.existsSync(target)) throw new Error(`Broken documentation link in ${path.relative(ROOT, file)}: ${match[1]}`);
  }
}

function requireText(haystack, needle, label = needle) {
  if (!haystack.includes(needle)) throw new Error(`Documentation contract missing: ${label}`);
}

const runtimeFiles = [
  'server.js', 'client.js', 'agent.js', 'studio-server.js', 'lib/server-config.js',
  'scripts/auth.js', 'scripts/auth_import.js', 'scripts/deepseek_chrome_auth.js', 'scripts/doctor.js',
];
const runtime = runtimeFiles.map(source).join('\n');
const envNames = [...runtime.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(match => match[1]);
const platformEnvironment = new Set(['HOME', 'USERPROFILE']);
const documentedEnvNames = new Set(envNames.filter(name => !platformEnvironment.has(name)));
for (const name of documentedEnvNames) requireText(allDocs, name, `environment variable ${name}`);

const publicApi = `${source('server.js')}\n${source('lib/api-routes.js')}`;
for (const route of [
  '/health', '/v1/models', '/v1/model-capabilities', '/api/model-capabilities', '/v1/sessions',
  '/reset-session', '/v1/chat/completions', '/v1/messages', '/v1/responses',
]) {
  requireText(publicApi, route, `implemented route ${route}`);
  requireText(docs['docs/api-documentation.md'], route, `documented route ${route}`);
}

for (const route of ['/api/events', '/api/state', '/api/file', '/api/tasks', '/api/tasks/cancel', '/api/undo', '/api/session/reset']) {
  requireText(source('studio-server.js'), route, `implemented Studio route ${route}`);
  requireText(docs['docs/studio.md'], route, `documented Studio route ${route}`);
}

for (const option of ['--login', '--no-stream', '--project-map', '--max-steps', '--new-session', '--no-history', '--undo']) {
  requireText(runtime, option, `implemented option ${option}`);
  requireText(allDocs, option, `documented option ${option}`);
}

for (const key of ['permissionMode', 'protectedPaths', 'allowedPrograms', 'maxFileBytes', 'maxCommandOutputBytes', 'commandTimeoutMs', 'commandSandbox', 'dockerImage', 'sandboxMemoryMb', 'sandboxCpu', 'sandboxNetwork', 'rollbackOnFailure', 'historyEnabled', 'historyTtlDays', 'maxConversationExchanges', 'maxConversationChars']) {
  requireText(source('lib/agent-core.js'), key, `implemented agent config ${key}`);
  requireText(docs['docs/coding-agent.md'], key, `documented agent config ${key}`);
}

console.log(`Documentation contracts OK: ${docFiles.length} files, ${documentedEnvNames.size} environment variables.`);
