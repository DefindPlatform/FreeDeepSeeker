# FreeDeepseekAPI

FreeDeepseekAPI — локальный OpenAI-/Anthropic-совместимый HTTP-прокси для DeepSeek Web Chat (`chat.deepseek.com`).

Этот проект превращает DeepSeek Web в совместимый с OpenAI и Anthropic API локальный сервер. Он поддерживает `POST /v1/chat/completions`, `POST /v1/messages` и `POST /v1/responses`, потоковую передачу (SSE), повторное использование сессий, мульти-аккаунтный пул и локальные утилиты.

> ⚠️ Это экспериментальный инструмент. Внутренний контракт DeepSeek Web может измениться в любой момент.

## Быстрый старт

```bash
git clone https://github.com/DefindPlatform/FreeDeepSeeker.git
cd freedeepseekapi
npm install
npm run auth
npm start
```

Запуск без интерактивного меню:

```bash
NON_INTERACTIVE=1 npm start
```

Если auth-файл уже готов:

```bash
DEEPSEEK_AUTH_PATH=./deepseek-auth.json NON_INTERACTIVE=1 npm start
```

По умолчанию сервер слушает только `127.0.0.1:9655`.

## Требования

- Node.js `>= 18` для API/CLI; Node.js `>= 20.19` для пересборки Studio (требование Vite)
- Chrome/Chromium для интерактивной авторизации
- Интернет для доступа к `chat.deepseek.com`

## Авторизация

FreeDeepseekAPI требует локальный auth-файл `deepseek-auth.json`, содержащий DeepSeek Web session/cookie/token.

### Стандартная авторизация

```bash
npm run auth
```

Откроется меню управления авторизацией. Выберите пункт `1`. Для прямого запуска Chrome без меню:

```bash
npm run auth -- --login
```

После входа скрипт сохранит локальный `deepseek-auth.json` с правами доступа `0600` на поддерживаемых системах.

### Импорт существующего auth-файла

```bash
npm run auth:import -- --input ./deepseek-auth.json
```

### Удалённый сервер / VPS

1. Авторизуйтесь на машине с браузером:
   ```bash
   npm run auth
   ```
2. Скопируйте `deepseek-auth.json` на сервер.
3. Запустите сервер на удалённой машине:
   ```bash
   DEEPSEEK_AUTH_PATH=./deepseek-auth.json NON_INTERACTIVE=1 npm start
   ```

## Структура файлов

- Подробная карта проекта: [`docs/project-structure.md`](docs/project-structure.md)
- `deepseek-auth.json` — приватный auth-файл, не добавляется в VCS
- `.chrome-for-testing-profile-deepseek/` — профиль браузера для авторизации
- `.deepseek-agent/` — состояние coding agent
- `dashboard/` — локальная Studio UI
- `scripts/` — утилиты и helper-скрипты
- `docs/` — дополнительная документация и [`docs/README.md`](docs/README.md)

## Запуск сервера

```bash
npm start
```

Настройки окружения:

- `PORT` — порт сервера (по умолчанию `9655`)
- `HOST` — хост (по умолчанию `127.0.0.1`)
- `FREEDEEPSEEK_API_KEY` — обязательно при запуске на non-loopback `HOST`
- `DEEPSEEK_AUTH_PATH` — путь к одному auth-файлу
- `DEEPSEEK_AUTH_DIR` — путь к директории auth-файлов
- `DEEPSEEK_ACCOUNT_COOLDOWN_MS` — задержка после `429` или auth-failure (по умолчанию `600000`)
- `NON_INTERACTIVE`, `SKIP_ACCOUNT_MENU` — отключают меню авторизации
- `CORS_ORIGIN` — разрешённый browser origin
- `MAX_REQUEST_BYTES` — максимальный размер тела запроса (по умолчанию `2097152`)
- `RATE_LIMIT_PER_MINUTE` — локальный rate limit (по умолчанию `120`)

Настройки клиентов и Studio:

- `DEEPSEEK_API_URL` — адрес локального proxy для CLI, coding agent и Studio
- `DEEPSEEK_MODEL` — модель по умолчанию для `client.js`
- `DEEPSEEK_AGENT_MODEL` — модель по умолчанию для coding agent
- `NO_COLOR` — отключить ANSI-цвета в терминале

Настройки Chrome-помощника (`DEEPSEEK_CHROME_PORT`, `DEEPSEEK_CHROME_PROFILE`, `DEEPSEEK_KEEP_CHROME_PROFILE`, `DEEPSEEK_REUSE_CHROME`, `CHROME_PATH`) приведены в [.env.example](.env.example) и [инструкции по авторизации](docs/browser-auth.md).

## API Endpoints

Если задан `FREEDEEPSEEK_API_KEY`, заголовок `Authorization: Bearer <key>` требуется для **всех** маршрутов, включая health, модели, сессии и сброс.

### Health и статус

```http
GET /
GET /health
```

### Модели

```http
GET /v1/models
GET /v1/model-capabilities
```

### Основные shимы

```http
POST /v1/chat/completions
POST /v1/messages
POST /v1/responses
```

### Сессии и сброс

```http
GET /v1/sessions
POST /reset-session?agent=<id>
POST /reset-session?agent=all
```

## Примеры запросов

### OpenAI Chat Completions

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Привет"}],"stream":false}'
```

### Streaming (SSE)

```bash
curl -N -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Напиши шутку"}],"stream":true}'
```

### Anthropic Messages shim

```bash
curl -X POST http://127.0.0.1:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"OK"}],"stream":false}'
```

### Responses API shim

```bash
curl -X POST http://127.0.0.1:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","input":"Ответь OK","stream":false}'
```

## CLI и утилиты

### Клиент

```bash
npm run client -- --help
npm run client -- Привет
npm run client -- -m deepseek-reasoner Реши задачу
```

Параметры клиента:

- `--url` — адрес API
- `--model`, `-m` — модель
- `--system`, `-s` — системная инструкция
- `--session` — постоянный идентификатор сессии
- `--no-stream`, `--stream` — отключить или включить поток
- `--list-models` — показать доступные модели
- `--no-auto-start` — не запускать локальный API автоматически

### Coding Agent

```bash
npm run agent -- --help
npm run agent -- --yes Исправь тесты
npm run agent -- --mode ask Проверь код на уязвимости
npm run agent -- --dry-run --report .deepseek-agent/report.json "Спланируй рефакторинг"
npm run agent -- --undo
```

Режимы:

- `read-only` — только чтение, изменения запрещены
- `ask` — превью изменений и подтверждение
- `full` — разрешены изменения и журналируются

Дополнительно:

- `--init` — создать `.deepseek-agent.json`
- `--allow-home` — разрешить рабочую папку в домашнем каталоге
- `--project-map` — вывести карту файлов проекта
- `--json` — JSON-вывод для `--project-map`
- `--max-steps` — ограничение числа вызовов модели
- `--max-duration-ms` — общий лимит времени запуска
- `--new-session` — очистить сохранённый контекст проекта перед задачей

По умолчанию новые задачи в одной рабочей папке продолжают предыдущий проектный диалог. История хранится локально в `.deepseek-agent/conversation.json`; долговременные решения, ограничения и незавершённые задачи — отдельно в `.deepseek-agent/memory.json`. Команда `/new` начинает новый диалог, но сохраняет знания проекта; `/memory` показывает их. Для разового запуска без чтения и сохранения истории используйте `--no-history`, а для постоянного приватного режима установите `historyEnabled: false` в `.deepseek-agent.json`.

### Studio

```bash
npm run studio -- --help
npm run studio -- -C C:\path\to\project --port 9660
npm run studio:build
```

Studio запускает локальный UI на `127.0.0.1:9660` и строго проверяет `Host`/`Origin`.
Меню рабочей папки запоминает до 30 проектов и переключает их без перезапуска Studio. Git-панель показывает ветку, изменённые файлы и diff, а также выполняет подтверждённые **Commit** и **Push** без shell и интерактивного ввода credentials.
Кнопка **Новый диалог** очищает контекст, но не откатывает изменения файлов.
Подробно: [Studio UI и локальный API](docs/studio.md).

### Chrome-расширение

Папка `chrome-extension/` содержит распаковываемое Manifest V3 расширение для экспорта текущей DeepSeek Web-сессии. Инструкция по установке, экспорту и безопасному импорту: [docs/browser-auth.md](docs/browser-auth.md).

## Модели и возможности

`GET /v1/models` возвращает алиасы моделей, проверенные proxy.

`GET /v1/model-capabilities` возвращает полный маппинг с реальными именами и возможностями.

Proxy поддерживает reasoning и web search для моделей, которые возвращают `thinking_enabled` и `search_enabled`.

## Диагностика

- `npm run doctor` — проверка auth, WASM и сетевых вызовов
- `npm test` — синтаксическая проверка и unit tests
- `npm run test:live` — live smoke-тесты против запущенного proxy

Если DeepSeek отвечает `401`, `403` или `429`, обновите auth и перезапустите `npm start`.

## Безопасность

- Сервер по умолчанию слушает только loopback (`127.0.0.1`)
- Non-loopback `HOST` разрешён только с `FREEDEEPSEEK_API_KEY`
- `CORS_ORIGIN` должен быть точным значением при браузерных запросах
- Никогда не коммитте `deepseek-auth.json`, `.env`, cookies или `.deepseek-agent/`
- `deepseek-agent --yes` не отключает защиту защищённых путей

См. подробности в [SECURITY.md](SECURITY.md).

## Документация

Дополнительная документация находится в папке `docs/`. Начните с [`docs/README.md`](docs/README.md):

- `docs/README.md`
- `docs/project-structure.md`
- `docs/api-documentation.md`
- `docs/architecture.md`
- `docs/coding-agent.md`
- `docs/agent-engine.md`
- `docs/studio.md`
- `docs/browser-auth.md`

## Контрибьютинг

См. [`CONTRIBUTING.md`](CONTRIBUTING.md) для инструкций по PR, тестированию и безопасности.

Перед отправкой PR:

- проверьте `npm test`
- для изменений UI выполните `npm run studio:build`
- добавьте документацию при изменении API
- убедитесь, что не добавляете приватные данные в коммит
