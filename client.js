#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawn } = require('child_process');

const DEFAULT_URL = process.env.DEEPSEEK_API_URL || 'http://localhost:9655';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MODEL_ORDER = [
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-chat-search',
  'deepseek-reasoner-search',
  'deepseek-expert',
  'deepseek-v4-pro',
];
const MODEL_LABELS = {
  'deepseek-chat': 'Быстрый чат',
  'deepseek-reasoner': 'Рассуждение',
  'deepseek-chat-search': 'Чат + интернет',
  'deepseek-reasoner-search': 'Рассуждение + интернет',
  'deepseek-expert': 'Эксперт',
  'deepseek-v4-pro': 'Эксперт + рассуждение',
};

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (code, text) => colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
const c = {
  bold: text => ansi('1', text),
  dim: text => ansi('2', text),
  cyan: text => ansi('36', text),
  green: text => ansi('32', text),
  yellow: text => ansi('33', text),
  red: text => ansi('31', text),
};

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    model: DEFAULT_MODEL,
    stream: true,
    system: '',
    session: '',
    listModels: false,
    autoStart: true,
    help: false,
    prompt: '',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inlineValue] = arg.split(/=(.*)/s, 2);
    const value = () => inlineValue !== undefined ? inlineValue : argv[++i];
    if (name === '--url') options.url = value();
    else if (name === '--model' || name === '-m') options.model = value();
    else if (name === '--system' || name === '-s') options.system = value();
    else if (name === '--session') options.session = value();
    else if (name === '--no-stream') options.stream = false;
    else if (name === '--stream') options.stream = true;
    else if (name === '--list-models') options.listModels = true;
    else if (name === '--no-auto-start') options.autoStart = false;
    else if (name === '--help' || name === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Неизвестный параметр: ${arg}`);
    else positional.push(arg);
  }
  options.url = String(options.url || DEFAULT_URL).replace(/\/+$/, '');
  options.model = String(options.model || DEFAULT_MODEL).toLowerCase();
  options.prompt = positional.join(' ').trim();
  return options;
}

function capabilityBadges(model) {
  const caps = model.capabilities || {};
  const badges = [];
  if (caps.reasoning) badges.push('reasoning');
  if (caps.web_search) badges.push('search');
  if (caps.files) badges.push('files');
  return badges.length ? badges.join(', ') : 'chat';
}

function sortModels(models) {
  return [...models].sort((a, b) => {
    const ai = MODEL_ORDER.indexOf(a.id);
    const bi = MODEL_ORDER.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.id.localeCompare(b.id);
  });
}

function modelTitle(model) {
  return MODEL_LABELS[model.id] || model.id;
}

function printModels(models, selected) {
  console.log();
  models.forEach((model, index) => {
    const active = model.id === selected ? c.green(' ●') : '  ';
    const title = modelTitle(model).padEnd(25);
    console.log(`${c.cyan(String(index + 1).padStart(2))}.${active} ${c.bold(title)} ${c.dim(model.id)}  ${c.yellow(`[${capabilityBadges(model)}]`)}`);
  });
  console.log();
}

function printHelp() {
  console.log(`
${c.bold('FreeDeepseekAPI CLI')}

Запуск:
  npm run client                         интерактивный чат
  npm run client -- "Привет"            одиночный запрос
  npm run client -- -m deepseek-reasoner "Реши задачу"

Параметры:
  -m, --model <id>       модель
  -s, --system <text>    системная инструкция
      --url <url>        адрес API (${DEFAULT_URL})
      --session <id>     постоянный ID сессии
      --no-stream        ждать ответ целиком
      --list-models      показать доступные модели
      --no-auto-start    не запускать локальный API автоматически
  -h, --help             эта справка

Команды в чате:
  /model [номер|id]      выбрать модель
  /models                список моделей
  /new                   начать новый разговор
  /stream [on|off]       переключить потоковый вывод
  /system [текст|off]    задать системную инструкцию
  /multiline             многострочный запрос (завершить строкой .)
  /save [файл]           сохранить последний ответ
  /status                текущие настройки
  /clear                 очистить экран
  /help                  справка
  /exit                  выход
`);
}

async function request(url, options = {}) {
  let response;
  try {
    if (process.env.FREEDEEPSEEK_API_KEY) {
      options.headers = { ...(options.headers || {}), Authorization: `Bearer ${process.env.FREEDEEPSEEK_API_KEY}` };
    }
    response = await fetch(url, options);
  } catch (error) {
    const wrapped = new Error(`API недоступен: ${url} (${error.message})`);
    wrapped.code = 'API_UNREACHABLE';
    throw wrapped;
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text);
      message = json.error?.message || json.message || message;
    } catch {}
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  return response;
}

async function loadModels(baseUrl) {
  const response = await request(`${baseUrl}/v1/models`);
  const json = await response.json();
  return sortModels(Array.isArray(json.data) ? json.data : []);
}

function isLocalApi(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startLocalApi(baseUrl) {
  const serverPath = path.join(__dirname, 'server.js');
  if (!fs.existsSync(serverPath)) throw new Error(`Не найден сервер: ${serverPath}`);
  const apiUrl = new URL(baseUrl);

  console.log(c.yellow('Локальный API не запущен. Запускаю сервер в фоне…'));
  const child = spawn(process.execPath, [serverPath], {
    cwd: __dirname,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NON_INTERACTIVE: '1',
      SKIP_ACCOUNT_MENU: '1',
      PORT: apiUrl.port || '9655',
    },
  });
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const headers = process.env.FREEDEEPSEEK_API_KEY
        ? { Authorization: `Bearer ${process.env.FREEDEEPSEEK_API_KEY}` }
        : {};
      const response = await fetch(`${baseUrl}/health`, { headers });
      if (response.ok) {
        console.log(c.green('API готов.'));
        return;
      }
    } catch {}
  }
  throw new Error('Сервер не запустился за 15 секунд. Выполните npm start, чтобы увидеть подробную ошибку.');
}

async function connectModels(options) {
  try {
    return await loadModels(options.url);
  } catch (error) {
    if (error.code !== 'API_UNREACHABLE' || !options.autoStart || !isLocalApi(options.url)) throw error;
    await startLocalApi(options.url);
    return loadModels(options.url);
  }
}

async function chooseModel(rl, models, current) {
  printModels(models, current);
  const answer = (await rl.question(`Модель [${current}]: `)).trim();
  if (!answer) return current;
  const byNumber = models[Number(answer) - 1];
  const byId = models.find(model => model.id.toLowerCase() === answer.toLowerCase());
  if (!byNumber && !byId) {
    console.log(c.red('Такой модели нет. Текущая модель не изменена.'));
    return current;
  }
  return (byNumber || byId).id;
}

function makeMessages(system, prompt) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function extractResponse(json) {
  const message = json.choices?.[0]?.message || {};
  return {
    content: message.content || '',
    reasoning: message.reasoning_content || '',
    finishReason: json.choices?.[0]?.finish_reason || '',
  };
}

async function readStreamingResponse(response, output = process.stdout) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let phase = '';

  const showDelta = delta => {
    if (delta.reasoning_content) {
      if (phase !== 'reasoning') output.write(`${phase ? '\n' : ''}${c.dim('Размышление:\n')}`);
      output.write(c.dim(delta.reasoning_content));
      reasoning += delta.reasoning_content;
      phase = 'reasoning';
    }
    if (delta.content) {
      if (phase !== 'content') output.write(`${phase ? '\n\n' : ''}${c.green('DeepSeek:\n')}`);
      output.write(delta.content);
      content += delta.content;
      phase = 'content';
    }
  };

  const consumeLine = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { showDelta(JSON.parse(data).choices?.[0]?.delta || {}); } catch {}
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  output.write('\n');
  return { content, reasoning };
}

async function ask(baseUrl, state, prompt) {
  const response = await request(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'x-agent-session': state.session,
    },
    body: JSON.stringify({
      model: state.model,
      messages: makeMessages(state.system, prompt),
      stream: state.stream,
    }),
  });

  if (state.stream) return readStreamingResponse(response);
  const result = extractResponse(await response.json());
  if (result.reasoning) console.log(`${c.dim('Размышление:')}\n${c.dim(result.reasoning)}\n`);
  console.log(`${c.green('DeepSeek:')}\n${result.content}`);
  return result;
}

async function resetSession(baseUrl, session) {
  await request(`${baseUrl}/reset-session?agent=${encodeURIComponent(session)}`, { method: 'POST' });
}

function printStatus(baseUrl, state) {
  console.log(`
API:      ${baseUrl}
Модель:   ${state.model}
Streaming:${state.stream ? ' on' : ' off'}
Сессия:   ${state.session}
System:   ${state.system || c.dim('не задан')}
`);
}

async function readMultiline(rl) {
  console.log(c.dim('Введите текст. Одна точка на новой строке завершает ввод.'));
  const lines = [];
  while (true) {
    const line = await rl.question(c.cyan('… '));
    if (line === '.') break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

async function interactive(options, models) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const state = {
    model: models.some(model => model.id === options.model) ? options.model : models[0]?.id,
    stream: options.stream,
    system: options.system,
    session: options.session || `cli-${Date.now().toString(36)}`,
    lastResponse: '',
  };

  console.log(c.bold('\nFreeDeepseekAPI CLI'));
  console.log(c.dim(`API: ${options.url}`));
  state.model = await chooseModel(rl, models, state.model);
  console.log(c.dim('Введите /help для списка команд. Ctrl+C или /exit — выход.\n'));

  rl.on('SIGINT', () => rl.close());
  while (true) {
    let input;
    try { input = (await rl.question(c.cyan('Вы: '))).trim(); }
    catch { break; }
    if (!input) continue;

    if (input === '/exit' || input === '/quit') break;
    if (input === '/help') { printHelp(); continue; }
    if (input === '/models') { printModels(models, state.model); continue; }
    if (input === '/clear') { console.clear(); continue; }
    if (input === '/status') { printStatus(options.url, state); continue; }
    if (input === '/multiline') input = await readMultiline(rl);
    else if (input === '/new') {
      try { await resetSession(options.url, state.session); console.log(c.green('Новый разговор начат.')); }
      catch (error) { console.log(c.red(error.message)); }
      continue;
    } else if (input.startsWith('/model')) {
      const wanted = input.slice('/model'.length).trim();
      if (!wanted) state.model = await chooseModel(rl, models, state.model);
      else {
        const selected = models[Number(wanted) - 1] || models.find(model => model.id.toLowerCase() === wanted.toLowerCase());
        if (selected) state.model = selected.id;
        else console.log(c.red('Такой модели нет. Используйте /models.'));
      }
      console.log(`Модель: ${c.green(state.model)}`);
      continue;
    } else if (input.startsWith('/stream')) {
      const value = input.slice('/stream'.length).trim().toLowerCase();
      state.stream = value ? ['on', '1', 'true', 'да'].includes(value) : !state.stream;
      console.log(`Streaming: ${state.stream ? c.green('on') : c.yellow('off')}`);
      continue;
    } else if (input.startsWith('/system')) {
      const value = input.slice('/system'.length).trim();
      state.system = value.toLowerCase() === 'off' ? '' : value;
      console.log(state.system ? c.green('Системная инструкция обновлена.') : c.yellow('Системная инструкция отключена.'));
      continue;
    } else if (input.startsWith('/save')) {
      if (!state.lastResponse) { console.log(c.yellow('Пока нечего сохранять.')); continue; }
      const requested = input.slice('/save'.length).trim();
      const file = path.resolve(requested || `deepseek-response-${Date.now()}.md`);
      fs.writeFileSync(file, state.lastResponse, 'utf8');
      console.log(c.green(`Сохранено: ${file}`));
      continue;
    } else if (input.startsWith('/')) {
      console.log(c.red('Неизвестная команда. Используйте /help.'));
      continue;
    }

    if (!input) continue;
    try {
      const result = await ask(options.url, state, input);
      state.lastResponse = result.content || result.reasoning || '';
    } catch (error) {
      console.log(c.red(`Ошибка: ${error.message}`));
    }
    console.log();
  }
  rl.close();
  console.log(c.dim('\nДо встречи.'));
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(c.red(error.message)); printHelp(); return 1; }
  if (options.help) { printHelp(); return 0; }

  const models = await connectModels(options);
  if (!models.length) throw new Error('Сервер не вернул ни одной доступной модели.');
  if (options.listModels) { printModels(models, options.model); return 0; }

  if (!options.prompt && !process.stdin.isTTY) options.prompt = fs.readFileSync(0, 'utf8').trim();
  if (!options.prompt) {
    await interactive(options, models);
    return 0;
  }

  if (!models.some(model => model.id === options.model)) {
    throw new Error(`Модель ${options.model} недоступна. Используйте --list-models.`);
  }
  const state = {
    model: options.model,
    stream: options.stream,
    system: options.system,
    session: options.session || `cli-${Date.now().toString(36)}`,
  };
  await ask(options.url, state, options.prompt);
  return 0;
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      console.error(c.red(`Ошибка: ${error.message}`));
      process.exitCode = 1;
    });
}

module.exports = {
  __test: { parseArgs, capabilityBadges, sortModels, extractResponse, makeMessages, isLocalApi },
  api: { request, connectModels },
};
