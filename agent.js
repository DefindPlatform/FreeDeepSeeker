#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline/promises');
const { api } = require('./client.js');
const core = require('./lib/agent-core.js');
const projectIndex = require('./lib/project-index.js');
const { createCodingToolRegistry } = require('./lib/tool-registry.js');
const { AgentRunController } = require('./lib/agent-runtime.js');

const DEFAULT_URL = process.env.DEEPSEEK_API_URL || 'http://localhost:9655';
const DEFAULT_MODEL = process.env.DEEPSEEK_AGENT_MODEL || 'deepseek-chat';
const IGNORED_DIRS = new Set(['.git', '.deepseek-agent', 'node_modules', '.next', 'dist', 'build', 'coverage', '__pycache__', '.venv']);
const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (code, text) => colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
const c = {
  bold: text => ansi('1', text), dim: text => ansi('2', text), cyan: text => ansi('36', text),
  green: text => ansi('32', text), yellow: text => ansi('33', text), red: text => ansi('31', text),
};

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(), url: DEFAULT_URL, model: DEFAULT_MODEL,
    yes: false, mode: '', undo: false, init: false, allowHome: false, projectMap: false, json: false, newSession: false, noHistory: false,
    dryRun: false, report: '', maxSteps: 25, maxToolCalls: 100, help: false, prompt: '',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    const [name, inlineValue] = arg.split(/=(.*)/s, 2);
    const value = () => {
      const result = inlineValue !== undefined ? inlineValue : argv[++i];
      if (result === undefined || result === '') throw new Error(`Для ${name} требуется значение`);
      return result;
    };
    if (name === '--workspace' || name === '-C') options.workspace = value();
    else if (name === '--url') options.url = value();
    else if (name === '--model' || name === '-m') options.model = value();
    else if (name === '--max-steps') options.maxSteps = Number(value());
    else if (name === '--max-tool-calls') options.maxToolCalls = Number(value());
    else if (name === '--yes' || name === '-y') options.yes = true;
    else if (name === '--mode') options.mode = value();
    else if (name === '--undo') options.undo = true;
    else if (name === '--init') options.init = true;
    else if (name === '--allow-home') options.allowHome = true;
    else if (name === '--project-map') options.projectMap = true;
    else if (name === '--json') options.json = true;
    else if (name === '--new-session') options.newSession = true;
    else if (name === '--no-history') options.noHistory = true;
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--report') options.report = value();
    else if (name === '--help' || name === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Неизвестный параметр: ${arg}`);
    else positional.push(arg);
  }
  options.workspace = path.resolve(options.workspace || process.cwd());
  options.url = String(options.url || DEFAULT_URL).replace(/\/+$/, '');
  options.model = String(options.model || DEFAULT_MODEL).toLowerCase();
  if (options.report) options.report = path.resolve(options.report);
  options.prompt = positional.join(' ').trim();
  if (options.mode && !['read-only', 'ask', 'full'].includes(options.mode)) throw new Error('--mode должен быть read-only, ask или full');
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 100) {
    throw new Error('--max-steps должен быть целым числом от 1 до 100');
  }
  if (!Number.isInteger(options.maxToolCalls) || options.maxToolCalls < 1 || options.maxToolCalls > 1000) {
    throw new Error('--max-tool-calls должен быть целым числом от 1 до 1000');
  }
  return options;
}

function printHelp() {
  console.log(`
${c.bold('DeepSeek Coding Agent')}

Использование:
  deepseek-agent                         интерактивный режим для текущей папки
  deepseek-agent "Исправь тесты"         выполнить одну задачу
  deepseek-agent -C C:\\project "задача" выбрать рабочую папку
  deepseek-agent --yes "задача"          автономно, без подтверждений

Параметры:
  -C, --workspace <path> рабочая папка (по умолчанию текущая)
  -m, --model <id>       модель (${DEFAULT_MODEL})
  -y, --yes              разрешить записи, удаления и команды без вопросов
      --mode <mode>      read-only, ask или full
      --undo             откатить последний завершённый запуск
      --init             создать .deepseek-agent.json
      --allow-home       явно разрешить workspace в домашней папке
      --project-map      показать полный индекс проекта и выйти
      --json             JSON-вывод для --project-map
      --new-session      очистить контекст проекта перед запуском
      --no-history       не читать и не сохранять историю этого запуска
      --dry-run          разрешить чтение, но только показать план изменений
      --report <path>    сохранить структурированный JSON-отчёт запуска
      --max-steps <n>    максимум вызовов модели (25)
      --max-tool-calls <n> максимум вызовов инструментов (100)
      --url <url>        адрес FreeDeepseekAPI
  -h, --help             справка

В интерактивном режиме: /help, /status, /mode, /undo, /models, /model, /exit
`);
}

function isHomeWorkspace(workspace) {
  try { return fs.realpathSync(workspace).toLowerCase() === fs.realpathSync(os.homedir()).toLowerCase(); }
  catch { return false; }
}

function capabilityBadges(model) {
  const caps = model.capabilities || {};
  return [caps.reasoning && 'reasoning', caps.web_search && 'search', caps.files && 'files'].filter(Boolean).join(', ') || 'chat';
}

function printModelMenu(models, current) {
  console.log();
  models.forEach((model, index) => {
    const selected = model.id === current ? c.green('●') : ' ';
    console.log(`${String(index + 1).padStart(2)}. ${selected} ${c.bold(model.id.padEnd(30))} ${c.dim(`[${capabilityBadges(model)}]`)}`);
  });
  console.log();
}

async function selectModel(rl, models, current) {
  printModelMenu(models, current);
  const answer = (await rl.question(`Модель [${current}]: `)).trim();
  if (!answer) return current;
  const selected = models[Number(answer) - 1] || models.find(model => model.id.toLowerCase() === answer.toLowerCase());
  if (!selected) {
    console.log(c.red('Такой модели нет. Текущая модель не изменена.'));
    return current;
  }
  return selected.id;
}

function printInteractiveHelp() {
  console.log(`
/project [фильтр]      показать карту всего проекта
/model                 выбрать модель из меню
/model <номер|id>      выбрать модель напрямую
/models                показать доступные модели
/mode <режим>          read-only, ask или full
/status                текущие настройки
/new                   очистить контекст проекта и начать новый диалог
/undo                  откатить последний запуск
/help                  эта справка
/exit                  выход
`);
}

const { isInside, resolveWorkspacePath } = core;

function relativePath(root, target) {
  return path.relative(root, target) || '.';
}

function walk(root, start, maxDepth = 3, limit = 500) {
  const entries = [];
  function visit(dir, depth) {
    if (entries.length >= limit || depth > maxDepth) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entries.length >= limit) break;
      if (item.isDirectory() && IGNORED_DIRS.has(item.name)) continue;
      const full = path.join(dir, item.name);
      const rel = relativePath(root, full);
      entries.push(item.isDirectory() ? `${rel}/` : rel);
      if (item.isDirectory() && !item.isSymbolicLink()) visit(full, depth + 1);
    }
  }
  visit(start, 0);
  return entries;
}

function readTextFile(file, maxBytes = 200000) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Это не файл');
  if (stat.size > maxBytes) throw new Error(`Файл слишком большой: ${stat.size} байт (лимит ${maxBytes})`);
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) throw new Error('Бинарный файл нельзя прочитать как текст');
  return buffer.toString('utf8');
}

const TOOL_REGISTRY = createCodingToolRegistry();
const TOOLS = TOOL_REGISTRY.schemas();

async function confirm(rl, message, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY || !rl) return false;
  const answer = (await rl.question(`${c.yellow(message)} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes' || answer === 'д' || answer === 'да';
}


async function authorizeMutation(context, message) {
  if (context.config.permissionMode === 'read-only') return false;
  if (context.config.permissionMode === 'full') return true;
  return confirm(context.rl, message, false);
}

function printChangePreview(before, after) {
  if (!process.stdout.isTTY) return;
  const oldLines = String(before).split(/\r?\n/);
  const newLines = String(after).split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
  const removed = oldLines.slice(prefix, oldEnd + 1).slice(0, 20);
  const added = newLines.slice(prefix, newEnd + 1).slice(0, 20);
  console.log(c.dim(`\nИзменение около строки ${prefix + 1}:`));
  removed.forEach(line => console.log(c.red(`- ${line}`)));
  added.forEach(line => console.log(c.green(`+ ${line}`)));
  if ((oldEnd - prefix + 1) > 20 || (newEnd - prefix + 1) > 20) console.log(c.dim('… diff сокращён'));
}

async function executeTool(name, args, context) {
  const { root, config, transaction } = context;
  if (name === 'get_project_map') {
    const index = projectIndex.createProjectIndex(root, config);
    return projectIndex.projectMapPage(index, args);
  }
  if (name === 'list_files') {
    const target = resolveWorkspacePath(root, args.path || '.');
    core.assertAccessible(root, target, config, 'list');
    if (!fs.statSync(target).isDirectory()) throw new Error('Указанный путь не является папкой');
    const entries = walk(root, target, Math.min(Number(args.depth ?? 3), 6)).filter(item => {
      try { return !core.isProtectedPath(root, path.join(root, item.replace(/\/$/, '')), config.protectedPaths); } catch { return false; }
    });
    return { path: relativePath(root, target), entries };
  }
  if (name === 'read_file') {
    const target = resolveWorkspacePath(root, args.path);
    core.assertAccessible(root, target, config, 'read');
    const lines = readTextFile(target).split(/\r?\n/);
    const start = Math.max(1, Number(args.start_line || 1));
    const end = Math.min(lines.length, Number(args.end_line || start + 399));
    return { path: relativePath(root, target), start_line: start, end_line: end, content: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') };
  }
  if (name === 'search_files') {
    const start = resolveWorkspacePath(root, args.path || '.');
    core.assertAccessible(root, start, config, 'search');
    const query = String(args.query || '');
    if (!query) throw new Error('Пустая строка поиска');
    const needle = args.case_sensitive ? query : query.toLowerCase();
    const files = fs.statSync(start).isFile() ? [relativePath(root, start)] : walk(root, start, 8, 2000).filter(item => !item.endsWith('/'));
    const matches = [];
    for (const rel of files) {
      if (matches.length >= 200) break;
      try {
        const file = path.join(root, rel);
        if (core.isProtectedPath(root, file, config.protectedPaths)) continue;
        const text = readTextFile(file, config.maxFileBytes);
        text.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < 200 && (args.case_sensitive ? line : line.toLowerCase()).includes(needle)) matches.push(`${rel}:${index + 1}: ${line.slice(0, 500)}`);
        });
      } catch {}
    }
    return { query, matches, truncated: matches.length >= 200 };
  }
  if (name === 'write_file') {
    const target = resolveWorkspacePath(root, args.path);
    core.assertAccessible(root, target, config, 'write');
    const content = String(args.content ?? '');
    if (Buffer.byteLength(content) > config.maxFileBytes) throw new Error(`Содержимое превышает лимит ${config.maxFileBytes} байт`);
    const existed = fs.existsSync(target);
    if (config.permissionMode === 'ask') printChangePreview(existed ? readTextFile(target, config.maxFileBytes) : '', content);
    if (context.dryRun) return { ok: true, dry_run: true, action: existed ? 'overwrite' : 'create', path: relativePath(root, target), bytes: Buffer.byteLength(content) };
    if (!await authorizeMutation(context, `${existed ? 'Перезаписать' : 'Создать'} ${relativePath(root, target)}?`)) return { ok: false, denied: true, mode: config.permissionMode };
    transaction.before(target);
    core.atomicWrite(target, content);
    transaction.after(target);
    return { ok: true, path: relativePath(root, target), bytes: Buffer.byteLength(content), created: !existed };
  }
  if (name === 'replace_in_file') {
    const target = resolveWorkspacePath(root, args.path);
    core.assertAccessible(root, target, config, 'replace');
    const oldText = String(args.old_text ?? '');
    const newText = String(args.new_text ?? '');
    if (!oldText) throw new Error('old_text не может быть пустым');
    const current = readTextFile(target, config.maxFileBytes);
    const count = current.split(oldText).length - 1;
    if (!count) throw new Error('old_text не найден в файле');
    if (!args.replace_all && count > 1) throw new Error(`old_text найден ${count} раз; уточните фрагмент или установите replace_all=true`);
    const updated = args.replace_all ? current.split(oldText).join(newText) : current.replace(oldText, newText);
    if (config.permissionMode === 'ask') printChangePreview(current, updated);
    if (context.dryRun) return { ok: true, dry_run: true, action: 'replace', path: relativePath(root, target), replacements: args.replace_all ? count : 1 };
    if (!await authorizeMutation(context, `Изменить ${relativePath(root, target)} (${args.replace_all ? count : 1} замена)?`)) return { ok: false, denied: true, mode: config.permissionMode };
    transaction.before(target);
    core.atomicWrite(target, updated);
    transaction.after(target);
    return { ok: true, path: relativePath(root, target), replacements: args.replace_all ? count : 1 };
  }
  if (name === 'delete_path') {
    const target = resolveWorkspacePath(root, args.path);
    core.assertAccessible(root, target, config, 'delete');
    if (target === root) throw new Error('Удаление корня рабочей папки запрещено');
    if (!fs.existsSync(target)) throw new Error('Путь не существует');
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() && !args.recursive) throw new Error('Для папки требуется recursive=true');
    if (context.dryRun) return { ok: true, dry_run: true, action: 'delete', path: relativePath(root, target), recursive: stat.isDirectory() };
    if (!await authorizeMutation(context, `УДАЛИТЬ ${relativePath(root, target)}?`)) return { ok: false, denied: true, mode: config.permissionMode };
    transaction.before(target);
    fs.rmSync(target, { recursive: stat.isDirectory(), force: false });
    transaction.after(target);
    return { ok: true, deleted: relativePath(root, target) };
  }
  if (name === 'run_command') {
    const program = String(args.program || '').trim();
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    if (!program) throw new Error('Пустая программа');
    core.validateCommand(program, commandArgs, root, config);
    if (context.dryRun) return { ok: true, dry_run: true, action: 'run', program, args: commandArgs };
    if (!await authorizeMutation(context, `Выполнить: ${program} ${commandArgs.join(' ')}?`)) return { ok: false, denied: true, mode: config.permissionMode };
    const timeoutMs = Math.min(Math.max(Number(args.timeout_ms || config.commandTimeoutMs), 1000), 120000);
    transaction.audit('command_started', { program, args: commandArgs, timeoutMs });
    const result = await core.runProgram(program, commandArgs, {
      cwd: root,
      timeoutMs,
      maxOutputBytes: config.maxCommandOutputBytes,
      sandbox: config.commandSandbox,
      dockerImage: config.dockerImage,
      sandboxMemoryMb: config.sandboxMemoryMb,
      sandboxCpu: config.sandboxCpu,
      sandboxNetwork: config.sandboxNetwork,
    });
    transaction.audit('command_finished', { program, exitCode: result.exit_code, timedOut: result.timed_out });
    return result;
  }
  throw new Error(`Неизвестный инструмент: ${name}`);
}

function systemPrompt(root, permissionMode, index, dryRun = false) {
  const prompt = `You are an autonomous coding agent working in this workspace: ${root}
You can inspect and modify the workspace only through the provided tools.
Current permission mode: ${permissionMode}.
Rules:
- Inspect relevant files before changing them; never invent file contents.
- Keep changes scoped to the user's request and preserve unrelated work.
- Prefer replace_in_file for focused edits and write_file for new files.
- Run relevant tests or checks after modifying code.
- Commands use {"program":"npm","args":["test"]}; never request shell syntax, pipes, redirects, or chained commands.
- Protected secret files are intentionally unavailable. Never ask the user to expose credentials.
- Never claim an action succeeded until its tool result confirms it.
- If a tool is denied, adapt or explain what remains.
- Dry-run mode: ${dryRun ? 'ENABLED. Inspect normally and request intended mutations/commands so they can be reported, but understand they will not execute.' : 'disabled.'}
- When the task is complete, respond with a concise summary of changes and verification.`;
  return `${prompt}\n\n${projectIndex.formatProjectContext(index)}`;
}

function printProjectSummary(index, query = '') {
  const page = projectIndex.projectMapPage(index, { query, limit: 120 });
  console.log(`
${c.bold(index.name)} — ${index.fileCount} файлов, ${index.testFileCount} тестовых, ${(index.totalBytes / 1024).toFixed(1)} КБ
Языки: ${index.languages.slice(0, 10).map(item => `${item.name} ${item.count}`).join(', ') || 'не определены'}
Ключевые файлы: ${index.keyFiles.join(', ') || 'нет'}
${query ? `Фильтр: ${query} (${page.totalMatched})\n` : ''}`);
  page.files.forEach(file => console.log(`${file.isTest ? c.yellow('T') : ' '} ${file.path} ${c.dim(`${file.bytes}b`)}`));
  if (page.hasMore) console.log(c.dim(`… ещё ${page.totalMatched - page.files.length}; используйте /project <часть пути>`));
  console.log();
}

async function runAgent(task, options, rl) {
  const root = fs.realpathSync(options.workspace);
  const index = projectIndex.createProjectIndex(root, options.config);
  const transaction = new core.RunTransaction(root, task);
  const runtime = new AgentRunController({
    runId: transaction.id, task, model: options.model, workspace: root, dryRun: options.dryRun,
    maxSteps: options.maxSteps, maxToolCalls: options.maxToolCalls,
  });
  runtime.start();
  let cancellationStarted = false;
  const cancelRun = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    runtime.finish('cancelled', 'Task cancelled by operator');
    if (options.report) runtime.write(options.report);
    try {
      if (options.config.rollbackOnFailure && transaction.manifest.entries.length > 0) transaction.rollback('cancelled');
      else transaction.finish('cancelled', 'Task cancelled by operator');
    } catch (error) {
      transaction.finish('cancelled', `Task cancelled; rollback failed: ${error.message}`);
    }
    process.exit(130);
  };
  process.once('SIGTERM', cancelRun);
  const session = options.sessionId || core.workspaceSessionId(root);
  let remoteHasContext = false;
  try {
    const sessionResponse = await api.request(`${options.url}/v1/sessions`);
    const sessionState = await sessionResponse.json();
    remoteHasContext = sessionState.agents?.some(item => item.agent === session);
  } catch {}
  const previous = remoteHasContext ? [] : core.loadConversation(root, options.config);
  const messages = [
    { role: 'system', content: systemPrompt(root, options.config.permissionMode, index, options.dryRun) },
    ...previous.flatMap(exchange => [
      { role: 'user', content: `[Previous project request]\n${exchange.user}` },
      { role: 'assistant', content: exchange.assistant },
    ]),
    { role: 'user', content: task },
  ];

  try {
  for (;;) {
    const step = runtime.beginStep();
    process.stdout.write(c.dim(`\n[${step}/${options.maxSteps}] DeepSeek думает…\r`));
    const response = await api.request(`${options.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-agent-session': session },
      body: JSON.stringify({ model: options.model, messages, tools: TOOLS, tool_choice: 'auto', stream: false }),
    });
    process.stdout.write(' '.repeat(60) + '\r');
    const json = await response.json();
    runtime.recordUsage(json.usage);
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error('Модель вернула ответ неизвестного формата');
    const calls = message.tool_calls || [];
    if (!calls.length) {
      console.log(`${c.green('DeepSeek:')}\n${message.content || '(задача завершена без комментария)'}`);
      transaction.finish('completed');
      runtime.finish('completed');
      core.saveConversationExchange(root, task, message.content || 'Задача завершена без итогового комментария.', options.config);
      return { completed: true, content: message.content || '', runId: transaction.id, report: runtime.toJSON() };
    }

    messages.push(message);
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); }
      catch { args = { raw: call.function?.arguments }; }
      const detail = args.path || args.program || args.query || '';
      console.log(`${c.cyan('→')} ${c.bold(name)} ${c.dim(String(detail).slice(0, 160))}`);
      let result;
      if (!TOOL_REGISTRY.has(name)) result = { ok: false, error: `Неизвестный инструмент: ${name}` };
      else {
        runtime.acceptToolCall(name, args);
        try { result = await executeTool(name, args, { root, rl, config: options.config, transaction, dryRun: options.dryRun }); }
        catch (error) { result = { ok: false, error: error.message }; }
      }
      runtime.recordToolResult(name, args, result, TOOL_REGISTRY.has(name) ? TOOL_REGISTRY.kind(name) : 'read');
      transaction.audit('tool_result', { tool: name, ok: result.ok !== false && !result.error, target: String(detail).slice(0, 500), error: result.error || null });
      console.log(`${result.ok === false || result.error ? c.red('← ошибка') : c.green('← готово')} ${c.dim(JSON.stringify(result).slice(0, 500))}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  } catch (error) {
    runtime.finish('failed', error.message);
    transaction.finish('failed', error.message);
    if (options.config.rollbackOnFailure && transaction.manifest.entries.length > 0) {
      try {
        const rollback = transaction.rollback('undone');
        console.log(c.yellow(`Изменения неуспешного запуска автоматически откатаны (${rollback.runId}).`));
      } catch (rollbackError) {
        console.log(c.red(`Автооткат не выполнен: ${rollbackError.message}`));
      }
    }
    throw error;
  } finally {
    process.removeListener('SIGTERM', cancelRun);
    if (options.report) runtime.write(options.report);
  }
}

async function resetAgentContext(options) {
  core.clearConversation(options.workspace);
  await resetRemoteContext(options);
}

async function resetRemoteContext(options) {
  const sessionId = options.sessionId || core.workspaceSessionId(options.workspace);
  try {
    await api.request(`${options.url}/reset-session?agent=${encodeURIComponent(sessionId)}&clear_history=true`, { method: 'POST' });
  } catch (error) {
    if (!/No session for agent|HTTP 404/i.test(error.message)) throw error;
  }
}

async function interactive(options, models) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${c.bold('\nDeepSeek Coding Agent')}\nПапка: ${c.cyan(options.workspace)}\nМодель: ${options.model}\nРежим: ${c.yellow(options.config.permissionMode)}\nПроект: ${options.projectIndex.fileCount} файлов · ${options.projectIndex.languages.slice(0, 4).map(item => item.name).join(', ')}\n`);
  console.log(c.dim('Опишите задачу. Команды: /status, /mode <read-only|ask|full>, /new, /undo, /model <id>, /exit'));
  rl.on('SIGINT', () => rl.close());
  while (true) {
    let task;
    try { task = (await rl.question(c.cyan('\nЗадача: '))).trim(); } catch { break; }
    if (!task) continue;
    if (task === '/exit' || task === '/quit') break;
    if (task === '/help') { printInteractiveHelp(); continue; }
    if (task === '/project' || task.startsWith('/project ')) {
      options.projectIndex = projectIndex.createProjectIndex(options.workspace, options.config);
      printProjectSummary(options.projectIndex, task.slice('/project'.length).trim());
      continue;
    }
    if (task === '/models') { printModelMenu(models, options.model); continue; }
    if (task === '/new') {
      try { await resetAgentContext(options); console.log(c.green('Контекст проекта очищен. Следующая задача начнёт новый диалог.')); }
      catch (error) { console.log(c.red(`Контекст не очищен: ${error.message}`)); }
      continue;
    }
    if (task === '/status') {
      console.log(`Папка: ${options.workspace}\nМодель: ${options.model}\nРежим: ${options.config.permissionMode}\nСессия: ${options.sessionId}\nИстория: ${options.config.historyEnabled ? `${core.loadConversation(options.workspace, options.config).length} диалогов` : 'отключена'}`);
      continue;
    }
    if (task === '/undo') {
      try { const result = core.undoLatestRun(options.workspace); console.log(c.green(`Откатан запуск ${result.runId}: ${result.restored.join(', ') || 'нет изменений'}`)); }
      catch (error) { console.log(c.red(`Откат не выполнен: ${error.message}`)); }
      continue;
    }
    if (task === '/mode') { console.log(`Текущий режим: ${options.config.permissionMode}. Варианты: read-only, ask, full`); continue; }
    if (task.startsWith('/mode ')) {
      const mode = task.slice(6).trim();
      if (!['read-only', 'ask', 'full'].includes(mode)) console.log(c.red('Режим: read-only, ask или full'));
      else { options.config.permissionMode = mode; console.log(`Режим: ${c.yellow(mode)}`); }
      continue;
    }
    if (task === '/model') {
      options.model = await selectModel(rl, models, options.model);
      console.log(`Модель: ${c.green(options.model)}`);
      continue;
    }
    if (task.startsWith('/model ')) {
      const wanted = task.slice(7).trim();
      const selected = models[Number(wanted) - 1] || models.find(model => model.id.toLowerCase() === wanted.toLowerCase());
      if (!selected) console.log(c.red('Такой модели нет. Используйте /models.'));
      else { options.model = selected.id; console.log(`Модель: ${c.green(options.model)}`); }
      continue;
    }
    if (task.startsWith('/')) { console.log(c.red('Неизвестная команда. Используйте /help.')); continue; }
    try { await runAgent(task, options, rl); }
    catch (error) { console.log(c.red(`Ошибка: ${error.message}`)); }
  }
  rl.close();
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(c.red(error.message)); printHelp(); return 1; }
  if (options.help) { printHelp(); return 0; }
  if (!fs.existsSync(options.workspace) || !fs.statSync(options.workspace).isDirectory()) throw new Error(`Рабочая папка не найдена: ${options.workspace}`);
  if (isHomeWorkspace(options.workspace) && !options.allowHome) {
    throw new Error(`Домашняя папка не может быть workspace по умолчанию. Перейдите в папку проекта или используйте -C C:\\path\\to\\project. Если это намеренно — добавьте --allow-home.`);
  }
  if (options.init) {
    const configPath = path.join(options.workspace, '.deepseek-agent.json');
    if (fs.existsSync(configPath)) throw new Error(`Конфигурация уже существует: ${configPath}`);
    const template = {
      permissionMode: 'ask',
      allowProtectedPaths: false,
      protectedPaths: ['secrets', 'config/production'],
      allowedPrograms: core.DEFAULT_ALLOWED_PROGRAMS,
      maxFileBytes: 1000000,
      maxCommandOutputBytes: 100000,
      commandTimeoutMs: 30000,
      commandSandbox: 'process',
      dockerImage: 'node:22-alpine',
      sandboxMemoryMb: 512,
      sandboxCpu: 1,
      sandboxNetwork: false,
      rollbackOnFailure: true,
      historyEnabled: true,
      historyTtlDays: 30,
      maxConversationExchanges: 12,
      maxConversationChars: 30000,
    };
    core.atomicWrite(configPath, `${JSON.stringify(template, null, 2)}\n`);
    console.log(c.green(`Создан ${configPath}`));
    return 0;
  }
  options.config = core.loadProjectConfig(options.workspace);
  options.sessionId = core.workspaceSessionId(options.workspace);
  if (options.noHistory) options.config.historyEnabled = false;
  if (!options.config.historyEnabled) options.sessionId = `${options.sessionId}-private-${process.pid}-${Date.now()}`;
  if (options.yes) options.config.permissionMode = 'full';
  if (options.mode) options.config.permissionMode = options.mode;
  options.projectIndex = projectIndex.createProjectIndex(options.workspace, options.config);
  if (options.projectMap) {
    if (options.json) console.log(JSON.stringify(options.projectIndex, null, 2));
    else printProjectSummary(options.projectIndex);
    return 0;
  }
  if (options.undo) {
    const result = core.undoLatestRun(options.workspace);
    console.log(c.green(`Откатан запуск ${result.runId}: ${result.restored.join(', ') || 'нет изменений'}`));
    return 0;
  }
  const models = await api.connectModels({ url: options.url, autoStart: true });
  if (!models.some(model => model.id === options.model)) throw new Error(`Модель ${options.model} недоступна`);
  if (options.newSession) {
    await resetAgentContext(options);
    console.log(c.green('Контекст проекта очищен.'));
  }
  if (!options.prompt && !process.stdin.isTTY) options.prompt = fs.readFileSync(0, 'utf8').trim();
  if (options.prompt) {
    const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    try { await runAgent(options.prompt, options, rl); }
    finally {
      if (!options.config.historyEnabled) await resetRemoteContext(options).catch(() => {});
      if (rl) rl.close();
    }
    return 0;
  }
  try { await interactive(options, models); }
  finally { if (!options.config.historyEnabled) await resetRemoteContext(options).catch(() => {}); }
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(c.red(`Ошибка: ${error.message}`));
    process.exitCode = 1;
  });
}

module.exports = { __test: { parseArgs, isInside, isHomeWorkspace, selectModel, resolveWorkspacePath, readTextFile, walk, executeTool, resetAgentContext } };
