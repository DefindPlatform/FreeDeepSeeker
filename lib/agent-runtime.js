const fs = require('fs');
const path = require('path');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

class AgentRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.recovery = options.recovery || null;
  }
}

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
    this.clock = options.clock || Date.now;
    this.maxSteps = Math.max(1, Number(options.maxSteps) || 25);
    this.maxToolCalls = Math.max(1, Number(options.maxToolCalls) || this.maxSteps * 4);
    this.repeatLimit = Math.max(2, Number(options.repeatLimit) || 3);
    this.maxDurationMs = Math.min(Math.max(Number(options.maxDurationMs) || 15 * 60_000, 1000), 24 * 60 * 60_000);
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
      metrics: { durationMs: 0, failedToolCalls: 0, deniedToolCalls: 0, toolCallsByKind: { read: 0, write: 0, command: 0 } },
      error: null,
    };
    this.startedAtMs = null;
    this.lastToolSignature = '';
    this.consecutiveRepeats = 0;
  }

  start() {
    if (this.report.state !== 'initialized') throw new Error('Запуск уже начат');
    this.report.state = 'running';
    this.report.startedAt = new Date().toISOString();
    this.startedAtMs = this.clock();
  }

  assertActive(signal) {
    if (signal?.aborted) throw new AgentRuntimeError('RUN_CANCELLED', 'Запуск отменён', { recovery: 'Повторите задачу, когда будете готовы продолжить.' });
    if (this.report.state !== 'running') throw new AgentRuntimeError('INVALID_STATE', 'Запуск не находится в состоянии running');
    if (this.clock() - this.startedAtMs >= this.maxDurationMs) {
      throw new AgentRuntimeError('DURATION_LIMIT', `Достигнут лимит времени ${this.maxDurationMs} мс`, { recovery: 'Увеличьте maxDurationMs или разбейте задачу.' });
    }
  }

  beginStep(signal) {
    this.assertActive(signal);
    if (this.report.steps >= this.maxSteps) throw new AgentRuntimeError('STEP_LIMIT', `Достигнут лимит ${this.maxSteps} шагов`, { recovery: 'Увеличьте --max-steps или сузьте задачу.' });
    this.report.steps += 1;
    return this.report.steps;
  }

  acceptToolCall(name, args, signal) {
    this.assertActive(signal);
    if (this.report.toolCalls >= this.maxToolCalls) throw new AgentRuntimeError('TOOL_CALL_LIMIT', `Достигнут лимит ${this.maxToolCalls} вызовов инструментов`, { recovery: 'Увеличьте --max-tool-calls или сократите план.' });
    const signature = toolSignature(name, args);
    this.consecutiveRepeats = signature === this.lastToolSignature ? this.consecutiveRepeats + 1 : 1;
    this.lastToolSignature = signature;
    if (this.consecutiveRepeats > this.repeatLimit) {
      throw new AgentRuntimeError('REPEATED_TOOL_LOOP', `Обнаружен цикл: ${name} повторён с одинаковыми аргументами ${this.consecutiveRepeats} раз подряд`, { recovery: 'Измените аргументы или выберите другой инструмент.' });
    }
    this.report.toolCalls += 1;
  }

  recordToolResult(name, args, result, kind = 'read') {
    if (this.report.metrics.toolCallsByKind[kind] !== undefined) this.report.metrics.toolCallsByKind[kind] += 1;
    if (result?.ok === false || result?.error) this.report.metrics.failedToolCalls += 1;
    if (result?.denied) this.report.metrics.deniedToolCalls += 1;
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
    this.report.metrics.durationMs = this.startedAtMs === null ? 0 : Math.max(0, this.clock() - this.startedAtMs);
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

module.exports = { AgentRunController, AgentRuntimeError, toolSignature };
