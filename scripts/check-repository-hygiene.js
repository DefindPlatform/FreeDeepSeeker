#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8', shell: false, windowsHide: true });
}

const inside = git(['rev-parse', '--is-inside-work-tree']);
if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
  console.log('Repository hygiene skipped: Git worktree is unavailable.');
  process.exit(0);
}

const tracked = git(['ls-files', '-z']);
if (tracked.status !== 0) throw new Error(tracked.stderr.trim() || 'git ls-files failed');
const files = tracked.stdout.split('\0').filter(Boolean).map(file => file.replace(/\\/g, '/'));

const ignoredTracked = git(['ls-files', '-ci', '--exclude-standard', '-z']);
if (ignoredTracked.status !== 0) throw new Error(ignoredTracked.stderr.trim() || 'git ignored-file check failed');
const ignored = ignoredTracked.stdout.split('\0').filter(Boolean);

const forbidden = files.filter(file => (
  /(^|\/)(node_modules|dist|build|out|coverage|playwright-report|blob-report|test-results|\.deepseek-agent|\.deepseek-studio)(\/|$)/i.test(file)
  || /(^|\/)(\.idea|\.vscode|__pycache__|\.pytest_cache|\.vite)(\/|$)/i.test(file)
  || ((/(^|\/)\.env(?:\..+)?$/i.test(file)) && file !== '.env.example')
  || (/((^|\/)(deepseek-auth|auth|credentials)(?:\.[^/]*)?\.json$)/i.test(file) && file !== 'auth.example.json')
  || /\.(?:log|pid|tmp|temp|session\.json|cookies\.json|har|trace\.zip)$/i.test(file)
  || /^docs\/roadmap-[^/]+\.md$/i.test(file)
  || /^scripts\/probe_[^/]+\.js$/i.test(file)
));

const problems = [...new Set([...ignored, ...forbidden])].sort();
const packageManifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageGlobs = (packageManifest.files || []).filter(entry => ['*', '?', '[', ']', '{', '}'].some(char => entry.includes(char)));
if (packageGlobs.length) {
  console.error('Repository hygiene failed. npm files must use an explicit allowlist so ignored local artifacts cannot leak:');
  packageGlobs.forEach(entry => console.error(`- ${entry}`));
  process.exit(1);
}
if (problems.length) {
  console.error('Repository hygiene failed. Remove generated or sensitive tracked files:');
  problems.forEach(file => console.error(`- ${file}`));
  process.exit(1);
}

console.log(`Repository hygiene OK: ${files.length} tracked files, no ignored/generated secrets in the index.`);
