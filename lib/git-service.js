const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_OUTPUT = 1024 * 1024;

function runGit(workspace, args, { timeout = 30000, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
  if (result.error) throw new Error(`Git недоступен: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(detail.slice(0, 2000));
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function repositoryRoot(workspace) {
  const result = runGit(workspace, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (result.status !== 0) return null;
  const workspaceRoot = fs.realpathSync.native(path.resolve(workspace));
  const root = fs.realpathSync.native(path.resolve(result.stdout.trim()));
  const relative = path.relative(workspaceRoot, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Корень Git находится выше рабочей папки; операция отклонена');
  }
  return root;
}

function parseBranch(line) {
  const value = line.replace(/^##\s*/, '');
  const [headPart, trackingPart = ''] = value.split(' [');
  const [branch, upstream = ''] = headPart.split('...');
  const stats = trackingPart.replace(/\]$/, '');
  return {
    branch: branch === 'HEAD (no branch)' ? 'detached' : branch,
    upstream: upstream || null,
    ahead: Number(stats.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(stats.match(/behind (\d+)/)?.[1] || 0),
  };
}

function parseStatus(output) {
  const entries = output.split('\0').filter(Boolean);
  const branch = entries[0]?.startsWith('## ') ? parseBranch(entries.shift()) : { branch: 'unknown', upstream: null, ahead: 0, behind: 0 };
  const files = [];
  for (let indexPosition = 0; indexPosition < entries.length; indexPosition++) {
    const entry = entries[indexPosition];
    if (entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    let filePath = entry.slice(3);
    if ((index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') && entries[indexPosition + 1]) {
      filePath = `${entries[++indexPosition]} → ${filePath}`;
    }
    files.push({ path: filePath, index, worktree, staged: index !== ' ' && index !== '?', untracked: index === '?' && worktree === '?' });
  }
  return { ...branch, files, dirty: files.length > 0 };
}

function getGitState(workspace, { includeDiff = true } = {}) {
  let root;
  try { root = repositoryRoot(workspace); }
  catch (error) {
    if (/Git недоступен/.test(error.message)) return { available: false, repository: false, dirty: false, files: [], diff: '', error: error.message };
    throw error;
  }
  if (!root) return { available: true, repository: false, dirty: false, files: [], diff: '' };
  const status = parseStatus(runGit(root, ['status', '--porcelain=v1', '-z', '--branch']).stdout);
  let diff = '';
  if (includeDiff && status.dirty) {
    const unstaged = runGit(root, ['diff', '--no-ext-diff', '--unified=3', '--', '.']).stdout;
    const staged = runGit(root, ['diff', '--cached', '--no-ext-diff', '--unified=3', '--', '.']).stdout;
    diff = `${staged ? `# Staged\n${staged}` : ''}${unstaged ? `${staged ? '\n' : ''}# Working tree\n${unstaged}` : ''}`.slice(0, MAX_OUTPUT);
  }
  return { available: true, repository: true, root, ...status, diff, truncated: diff.length >= MAX_OUTPUT };
}

function commitAll(workspace, message) {
  const root = repositoryRoot(workspace);
  if (!root) throw new Error('Рабочая папка не является Git-репозиторием');
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage || cleanMessage.length > 200 || /[\r\n]/.test(cleanMessage)) throw new Error('Сообщение коммита должно содержать 1–200 символов в одной строке');
  runGit(root, ['add', '-A', '--', '.']);
  const result = runGit(root, ['commit', '-m', cleanMessage]);
  const hash = runGit(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  return { hash, message: cleanMessage, output: result.stdout.trim() };
}

function pushCurrent(workspace) {
  const root = repositoryRoot(workspace);
  if (!root) throw new Error('Рабочая папка не является Git-репозиторием');
  const state = getGitState(root, { includeDiff: false });
  const args = state.upstream ? ['push'] : ['push', '--set-upstream', 'origin', state.branch];
  if (!state.upstream && (!state.branch || state.branch === 'detached' || state.branch === 'unknown')) throw new Error('Нельзя отправить detached HEAD');
  const result = runGit(root, args, { timeout: 120000 });
  return { branch: state.branch, upstream: state.upstream || `origin/${state.branch}`, output: `${result.stdout}${result.stderr}`.trim() };
}

module.exports = { runGit, repositoryRoot, parseStatus, getGitState, commitAll, pushCurrent };
