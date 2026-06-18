const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isInside, isProtectedPath, normalizeRelative } = require('./agent-core.js');

const FALLBACK_IGNORES = new Set([
  '.git', '.deepseek-agent', 'node_modules', '.next', '.nuxt', '.cache',
  'dist', 'build', 'coverage', 'target', '__pycache__', '.venv', 'venv',
]);
const EXTENSIONS = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin',
  '.cs': 'C#', '.cpp': 'C++', '.cc': 'C++', '.c': 'C', '.h': 'C/C++',
  '.swift': 'Swift', '.rb': 'Ruby', '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.sql': 'SQL', '.sh': 'Shell',
  '.ps1': 'PowerShell', '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML',
};
const KEY_FILE_NAMES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'dockerfile', 'docker-compose.yml', 'compose.yml',
  'readme.md', 'agents.md', 'tsconfig.json', 'vite.config.js', 'vite.config.ts',
  'next.config.js', 'next.config.mjs', '.deepseek-agent.json',
]);

function gitFiles(root) {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean);
}

function fallbackFiles(root, limit) {
  const files = [];
  function visit(dir) {
    if (files.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) break;
      if (entry.isDirectory() && FALLBACK_IGNORES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(normalizeRelative(root, full));
    }
  }
  visit(root);
  return files;
}

function readPackageMetadata(root) {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      name: pkg.name || null,
      version: pkg.version || null,
      scripts: Object.keys(pkg.scripts || {}),
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {}),
    };
  } catch { return null; }
}

function createProjectIndex(root, config = {}, options = {}) {
  const realRoot = fs.realpathSync(root);
  const limit = Math.min(Math.max(Number(options.limit || 50000), 100), 100000);
  const fromGit = gitFiles(realRoot);
  const candidates = (fromGit || fallbackFiles(realRoot, limit)).slice(0, limit);
  const files = [];
  const languages = new Map();
  const directories = new Map();
  const keyFiles = [];
  let totalBytes = 0;
  let testFiles = 0;

  for (const relativeInput of candidates) {
    const full = path.resolve(realRoot, relativeInput);
    if (!isInside(realRoot, full) || isProtectedPath(realRoot, full, config.protectedPaths || [])) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const relative = normalizeRelative(realRoot, full);
    const ext = path.extname(relative).toLowerCase();
    const language = EXTENSIONS[ext] || (ext ? ext.slice(1).toUpperCase() : 'Other');
    const topDirectory = relative.includes('/') ? relative.split('/')[0] : '(root)';
    const isTest = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/i.test(relative);
    const isKey = KEY_FILE_NAMES.has(path.basename(relative).toLowerCase());
    files.push({ path: relative, bytes: stat.size, language, isTest, isKey });
    totalBytes += stat.size;
    languages.set(language, (languages.get(language) || 0) + 1);
    directories.set(topDirectory, (directories.get(topDirectory) || 0) + 1);
    if (isTest) testFiles++;
    if (isKey) keyFiles.push(relative);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const sortCounts = map => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  return {
    generatedAt: new Date().toISOString(),
    root: realRoot,
    name: path.basename(realRoot),
    source: fromGit ? 'git' : 'filesystem',
    truncated: candidates.length >= limit,
    fileCount: files.length,
    testFileCount: testFiles,
    totalBytes,
    languages: sortCounts(languages),
    directories: sortCounts(directories),
    keyFiles: keyFiles.sort(),
    package: readPackageMetadata(realRoot),
    files,
  };
}

function projectMapPage(index, options = {}) {
  const query = String(options.query || '').toLowerCase();
  const offset = Math.max(0, Number(options.offset || 0));
  const limit = Math.min(Math.max(Number(options.limit || 250), 1), 1000);
  const filtered = query ? index.files.filter(file => file.path.toLowerCase().includes(query)) : index.files;
  return {
    project: index.name,
    source: index.source,
    fileCount: index.fileCount,
    totalMatched: filtered.length,
    offset,
    limit,
    hasMore: offset + limit < filtered.length,
    files: filtered.slice(offset, offset + limit),
  };
}

function formatProjectContext(index, maxFiles = 240) {
  const files = index.files.slice(0, maxFiles).map(file => file.path);
  const more = index.fileCount > files.length ? `\n... and ${index.fileCount - files.length} more files available via get_project_map` : '';
  const packageLine = index.package
    ? `Package: ${index.package.name || index.name}@${index.package.version || '?'}; scripts: ${index.package.scripts.join(', ') || 'none'}`
    : 'Package metadata: none';
  return `PROJECT INDEX (${index.source}, generated ${index.generatedAt})
Root: ${index.root}
Files: ${index.fileCount}; tests: ${index.testFileCount}; size: ${index.totalBytes} bytes
Languages: ${index.languages.slice(0, 12).map(item => `${item.name} ${item.count}`).join(', ') || 'unknown'}
Top areas: ${index.directories.slice(0, 15).map(item => `${item.name} ${item.count}`).join(', ') || 'none'}
Key files: ${index.keyFiles.join(', ') || 'none'}
${packageLine}
File map:
${files.join('\n')}${more}`;
}

module.exports = { createProjectIndex, projectMapPage, formatProjectContext };
