const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultRegistryPath() {
  return path.join(os.homedir(), '.deepseek-studio', 'projects.json');
}

function validateProject(projectPath) {
  const resolved = path.resolve(String(projectPath || '').trim());
  if (!projectPath || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Рабочая папка не найдена: ${resolved}`);
  return fs.realpathSync(resolved);
}

function readProjects(file = defaultRegistryPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value.projects)) return [];
    return value.projects.flatMap(item => {
      try { return [validateProject(item.path)]; } catch { return []; }
    }).filter((item, index, list) => list.indexOf(item) === index);
  } catch { return []; }
}

function writeProjects(projects, file = defaultRegistryPath()) {
  const unique = projects.map(validateProject).filter((item, index, list) => list.indexOf(item) === index).slice(0, 30);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, projects: unique.map(projectPath => ({ path: projectPath })) }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return unique;
}

function addProject(projects, projectPath, file = defaultRegistryPath()) {
  const validated = validateProject(projectPath);
  return writeProjects([validated, ...projects.filter(item => item !== validated)], file);
}

function describeProjects(projects, active) {
  return projects.map(projectPath => ({ path: projectPath, name: path.basename(projectPath), active: projectPath === active }));
}

module.exports = { defaultRegistryPath, validateProject, readProjects, writeProjects, addProject, describeProjects };
