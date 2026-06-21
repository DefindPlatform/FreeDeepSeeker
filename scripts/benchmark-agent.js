#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { AgentRunController } = require('../lib/agent-runtime.js');
const { createCodingToolRegistry } = require('../lib/tool-registry.js');
const taskPlan = require('../lib/task-plan.js');

const budgetMs = Math.max(100, Number(process.env.AGENT_BENCHMARK_BUDGET_MS) || 2000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-benchmark-'));
const started = performance.now();

for (let i = 0; i < 10000; i++) {
  const runtime = new AgentRunController({ maxSteps: 1, maxToolCalls: 1 });
  runtime.start();
  runtime.beginStep();
  runtime.acceptToolCall('read_file', { path: `${i}.txt` });
  runtime.recordToolResult('read_file', { path: `${i}.txt` }, { ok: true }, 'read');
  runtime.finish('completed');
}

const registry = createCodingToolRegistry();
for (let i = 0; i < 2000; i++) registry.validate('read_file', { path: `${i}.txt`, start_line: 1, end_line: 20 });

const tasks = Array.from({ length: 100 }, (_, index) => ({
  id: `T${index + 1}`,
  title: `Task ${index + 1}`,
  dependsOn: index ? [`T${index}`] : [],
}));
taskPlan.saveTaskPlan(root, { goal: 'Benchmark', tasks });
taskPlan.loadTaskPlan(root);

const durationMs = performance.now() - started;
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ durationMs: Number(durationMs.toFixed(2)), budgetMs, operations: 12102 }));
if (durationMs > budgetMs) {
  console.error(`Agent benchmark exceeded budget: ${durationMs.toFixed(2)}ms > ${budgetMs}ms`);
  process.exitCode = 1;
}
