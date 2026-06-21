const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLAN_FILE = 'plan.json';
const TASK_STATES = new Set(['pending', 'in_progress', 'completed', 'blocked', 'failed', 'cancelled']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const TRANSITIONS = {
  pending: new Set(['in_progress', 'blocked', 'cancelled']),
  in_progress: new Set(['completed', 'blocked', 'failed', 'cancelled']),
  blocked: new Set(['pending', 'in_progress', 'cancelled']),
  failed: new Set(['pending', 'cancelled']),
  completed: new Set(),
  cancelled: new Set(['pending']),
};

function planPath(root) {
  return path.join(fs.realpathSync(root), '.deepseek-agent', PLAN_FILE);
}

function normalizeTask(input, index, knownIds) {
  const id = String(input?.id || `T${String(index + 1).padStart(3, '0')}`).trim();
  const title = String(input?.title || '').trim();
  const state = String(input?.state || 'pending');
  const dependsOn = [...new Set(Array.isArray(input?.dependsOn) ? input.dependsOn.map(String) : [])];
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) throw new Error(`Некорректный id задачи: ${id}`);
  if (knownIds.has(id)) throw new Error(`Повторяющийся id задачи: ${id}`);
  if (!title || title.length > 300) throw new Error(`Задаче ${id} требуется название длиной до 300 символов`);
  if (!TASK_STATES.has(state)) throw new Error(`Задача ${id}: неизвестное состояние ${state}`);
  if (dependsOn.includes(id)) throw new Error(`Задача ${id} не может зависеть от себя`);
  knownIds.add(id);
  return { id, title, state, dependsOn, note: String(input?.note || '').slice(0, 1000) };
}

function assertAcyclic(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error(`Циклическая зависимость плана около ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) {
      if (!byId.has(dependency)) throw new Error(`Неизвестная зависимость ${dependency} у задачи ${id}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach(task => visit(task.id));
}

function normalizePlan(input, options = {}) {
  const rawTasks = Array.isArray(input?.tasks) ? input.tasks : [];
  const maxTasks = Math.min(Math.max(Number(options.maxTasks) || 100, 1), 500);
  if (!rawTasks.length || rawTasks.length > maxTasks) throw new Error(`План должен содержать от 1 до ${maxTasks} задач`);
  const knownIds = new Set();
  const tasks = rawTasks.map((task, index) => normalizeTask(task, index, knownIds));
  assertAcyclic(tasks);
  return {
    version: 1,
    id: String(input?.id || crypto.randomUUID()),
    goal: String(input?.goal || '').trim().slice(0, 2000),
    revision: Math.max(1, Number(input?.revision) || 1),
    createdAt: input?.createdAt || new Date().toISOString(),
    updatedAt: options.preserveUpdatedAt && input?.updatedAt ? input.updatedAt : new Date().toISOString(),
    tasks,
  };
}

function atomicSave(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function loadTaskPlan(root) {
  const file = planPath(root);
  if (!fs.existsSync(file)) return null;
  try { return normalizePlan(JSON.parse(fs.readFileSync(file, 'utf8')), { maxTasks: 500, preserveUpdatedAt: true }); }
  catch (error) { throw new Error(`Некорректный план задач: ${error.message}`); }
}

function saveTaskPlan(root, input, options = {}) {
  const current = fs.existsSync(planPath(root)) ? loadTaskPlan(root) : null;
  const currentRevision = current?.revision || 0;
  if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== currentRevision) {
    throw new Error(`Конфликт версии плана: ожидалась ${options.expectedRevision}, текущая ${currentRevision}`);
  }
  const plan = normalizePlan({ ...input, revision: (current?.revision || 0) + 1, id: current?.id || input?.id, createdAt: current?.createdAt || input?.createdAt }, options);
  atomicSave(planPath(root), plan);
  return plan;
}

function progress(plan) {
  const counts = Object.fromEntries([...TASK_STATES].map(state => [state, 0]));
  for (const task of plan?.tasks || []) counts[task.state] += 1;
  const total = plan?.tasks?.length || 0;
  return { total, counts, completed: counts.completed, percent: total ? Math.round((counts.completed / total) * 100) : 0 };
}

function readyTasks(plan) {
  const completed = new Set(plan.tasks.filter(task => task.state === 'completed').map(task => task.id));
  return plan.tasks.filter(task => task.state === 'pending' && task.dependsOn.every(id => completed.has(id)));
}

function updateTask(root, id, nextState, note = '', options = {}) {
  if (!TASK_STATES.has(nextState)) throw new Error(`Неизвестное состояние задачи: ${nextState}`);
  const plan = loadTaskPlan(root);
  if (!plan) throw new Error('План задач ещё не создан');
  if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== plan.revision) {
    throw new Error(`Конфликт версии плана: ожидалась ${options.expectedRevision}, текущая ${plan.revision}`);
  }
  const task = plan.tasks.find(item => item.id === String(id));
  if (!task) throw new Error(`Задача не найдена: ${id}`);
  if (task.state !== nextState && !TRANSITIONS[task.state].has(nextState)) throw new Error(`Недопустимый переход ${task.state} -> ${nextState}`);
  if (nextState === 'in_progress') {
    const incomplete = task.dependsOn.filter(dependency => plan.tasks.find(item => item.id === dependency)?.state !== 'completed');
    if (incomplete.length) throw new Error(`Не завершены зависимости: ${incomplete.join(', ')}`);
  }
  task.state = nextState;
  task.note = String(note || task.note || '').slice(0, 1000);
  if (TERMINAL_STATES.has(nextState)) task.finishedAt = new Date().toISOString();
  plan.revision += 1;
  plan.updatedAt = new Date().toISOString();
  atomicSave(planPath(root), plan);
  return { plan, task, progress: progress(plan), ready: readyTasks(plan) };
}

module.exports = {
  TASK_STATES, TERMINAL_STATES, planPath, normalizePlan, loadTaskPlan, saveTaskPlan,
  updateTask, progress, readyTasks,
};
