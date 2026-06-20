const fs = require('fs');
const path = require('path');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function toolSignature(name, args) {
  return `${name}:${JSON.stringify(stableValue(args || {}))}`;
}

class AgentRunController {
  constructor(options = {}) {
    this.maxSteps = Math.max(1, Number(options.maxSteps) || 25);
    this.maxToolCalls = Math.max(1, Number(options.maxToolCalls) || this.maxSteps * 4);
    this.repeatLimit = Math.max(2, Number(options.repeatLimit) || 3);
    this.report = {
      version: 1,
      runId: options.runId || null,
      task: options.task || '',
      model: options.model || '',
      workspace: options.workspace || '',
      dryRun: Boolean(options.dryRun),
      state: 'initialized',
      startedAt: null,
      finishedAt: null,
      steps: 0,
      toolCalls: 0,
      toolResults: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      error: null,
    };
    this.lastToolSignature = '';
    this.consecutiveRepeats = 0;
  }

  start() {
    if (this.report.state !== 'initialized') throw new Error('Запуск уже начат');
    this.report.state = 'running';
    this.report.startedAt = new Date().toISOString();
  }

  beginStep() {
    if (this.report.state !== 'running') throw new Error('Запуск не находится в состоянии running');
    if (this.report.steps >= this.maxSteps) throw new Error(`Достигнут лимит ${this.maxSteps} шагов`);
    this.report.steps += 1;
    return this.report.steps;
  }

  acceptToolCall(name, args) {
    if (this.report.toolCalls >= this.maxToolCalls) throw new Error(`Достигнут лимит ${this.maxToolCalls} вызовов инструментов`);
    const signature = toolSignature(name, args);
    this.consecutiveRepeats = signature === this.lastToolSignature ? this.consecutiveRepeats + 1 : 1;
    this.lastToolSignature = signature;
    if (this.consecutiveRepeats > this.repeatLimit) {
      throw new Error(`Обнаружен цикл: ${name} повторён с одинаковыми аргументами ${this.consecutiveRepeats} раз подряд`);
    }
    this.report.toolCalls += 1;
  }

  recordToolResult(name, args, result, kind = 'read') {
    this.report.toolResults.push({
      tool: name,
      kind,
      target: String(args?.path || args?.program || args?.query || '').slice(0, 500),
      ok: result?.ok !== false && !result?.error,
      denied: Boolean(result?.denied),
      dryRun: Boolean(result?.dry_run),
      error: result?.error || null,
    });
  }

  recordUsage(usage = {}) {
    for (const key of Object.keys(this.report.usage)) this.report.usage[key] += Number(usage[key]) || 0;
  }

  finish(state, error = null) {
    if (!TERMINAL_STATES.has(state)) throw new Error(`Неизвестное конечное состояние: ${state}`);
    if (TERMINAL_STATES.has(this.report.state)) return;
    this.report.state = state;
    this.report.error = error ? String(error) : null;
    this.report.finishedAt = new Date().toISOString();
  }

  toJSON() {
    return JSON.parse(JSON.stringify(this.report));
  }

  write(file) {
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    return target;
  }
}

module.exports = { AgentRunController, toolSignature };
