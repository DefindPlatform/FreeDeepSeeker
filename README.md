Explanation: Заменяю устаревший и очень длинный README на компактную, полную русскую документацию с навигацией и инструкциями по запуску.

<!--
  README.md — обновлённая русская документация для GitHub.
  Этот файл содержит краткое описание проекта, требования, инструкции по авторизации и запуску,
  примеры запросов, ссылку на основные исходники и рекомендации по отладке.
-->

# FreeDeepseekAPI

FreeDeepseekAPI — локальный OpenAI-/Anthropic‑совместимый API‑прокси для DeepSeek Web Chat (`chat.deepseek.com`).
Позволяет использовать веб‑версию DeepSeek как локальный HTTP API для OpenAI/Anthropic/Responses‑совместимых клиентов: CLI, Open WebUI, Claude Code и т.д.

Ключевые возможности:
- OpenAI Chat Completions shim (`POST /v1/chat/completions`).
- Anthropic Messages shim (`POST /v1/messages`) и Responses shim (`POST /v1/responses`).
- Streaming (SSE) и non‑stream режимы.
- Поддержка reasoning-фрагментов (`reasoning_content`) и tool calling.
- Мульти‑аккаунтный пул, sticky accounts per session.

Файлы и точки входа:
- Основной сервер: [server.js](server.js)
- CLI клиент: [client.js](client.js)
- Agent: [agent.js](agent.js)
- Studio: [studio-server.js](studio-server.js)
- Документация: [docs/api-documentation.md](docs/api-documentation.md), [docs/coding-agent.md](docs/coding-agent.md)

---

## Содержание

- Кратко
- Требования
- Авторизация (auth)
- Быстрый старт
- Headless / VPS
- Переменные окружения
- Основные endpoint'ы и примеры
- Диагностика
- Безопасность и ограничения
- Контрибьютинг и лицензия

---

## Кратко
Сервер принимает совместимые с OpenAI/Anthropic запросы и пересылает их в DeepSeek Web, используя сохранённую browser‑сессию (файл `deepseek-auth.json`). Это даёт возможность использовать бесплатную web‑версию DeepSeek как «локальный» LLM‑endpoint.

---

## Требования
- Node.js >= 18
- Chrome/Chromium для интерактивной авторизации (локально)
- Доступ в интернет к `chat.deepseek.com`

Проверьте `package.json` для доступных скриптов: [package.json](package.json)

---

## Авторизация (получение `deepseek-auth.json`)

1) Локально (GUI):

```bash
git clone https://github.com/DefindPlatform/freedeepseekapi.git
cd FreeDeepseekAPI
npm run auth
```

Скрипт откроет браузер, вы выполните вход в DeepSeek, сервис сохранит `deepseek-auth.json`.

2) Импорт готового файла или cookies:

```bash
npm run auth:import -- --input ./deepseek-auth.json
```

3) Для VPS: авторизуйтесь на машине с GUI, скопируйте `deepseek-auth.json` на сервер и импортируйте.

Внимание: `deepseek-auth.json` — приватный файл, не добавляйте в репозиторий. Храните с правами 600.

Скрипты авторизации: [scripts/deepseek_chrome_auth.js](scripts/deepseek_chrome_auth.js), [scripts/auth.js](scripts/auth.js), [scripts/auth_import.js](scripts/auth_import.js)

---

## Быстрый старт

Локально, интерактивно:

```bash
git clone https://github.com/DefindPlatform/freedeepseekapi.git
cd FreeDeepseekAPI
npm run auth
npm start
```

Без меню (headless):

```bash
NON_INTERACTIVE=1 npm start
```

После запуска доступны:
- `POST /v1/chat/completions` — основной endpoint
- `GET /v1/models` и `GET /v1/model-capabilities`

---

## Headless / VPS

1. На машине с GUI: `npm run auth` → получите `deepseek-auth.json`.
2. Скопируйте файл на сервер и импортируйте: `npm run auth:import -- --input ./deepseek-auth.json`.
3. Запустите сервер без меню: `NON_INTERACTIVE=1 npm start`.

---

## Важные переменные окружения

- `PORT` — порт (по умолчанию 9655)
- `HOST` — хост (по умолчанию 127.0.0.1)
- `FREEDEEPSEEK_API_KEY` — при задании будет требоваться API‑ключ
- `DEEPSEEK_AUTH_PATH` — путь к одному auth‑файлу
- `DEEPSEEK_AUTH_DIR` — директория с несколькими auth‑файлами
- `DEEPSEEK_ACCOUNT_COOLDOWN_MS` — cooldown при rate limit
- `NON_INTERACTIVE`, `SKIP_ACCOUNT_MENU` — обход меню
- `CORS_ORIGIN` — разрешённый браузерный origin

Пример запуска:

```bash
DEEPSEEK_AUTH_PATH=./deepseek-auth.json NON_INTERACTIVE=1 npm start
```

---

## Основные endpoint'ы и примеры

- `GET /` или `GET /health` — статус
- `GET /v1/models` — список aliases
- `GET /v1/model-capabilities` — подробный маппинг
- `POST /v1/chat/completions` — OpenAI Chat Completions
- `POST /v1/messages` — Anthropic Messages shim
- `POST /v1/responses` — Responses API shim

Примеры:

Chat completion (non‑stream):

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Привет"}],"stream":false}'
```

Streaming (SSE):

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Напиши шутку."}],"stream":true}'
```

Anthropic shim:

```bash
curl -X POST http://localhost:9655/v1/messages -H "Content-Type: application/json" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"OK"}],"stream":false}'
```

---

## Диагностика

Запустите `npm run doctor` для базовой проверки auth, wasm, и сетевых вызовов.
Логи сервера выводятся в консоль; при ошибках авторизации (`401/403`) выполните `npm run auth`.

---

## Безопасность и ограничения

- Это reverse‑engineered проект: DeepSeek Web может изменить контракт в любой момент.
- `deepseek-auth.json` — приватный файл, не коммитить.
- По умолчанию сервер ограничен loopback; для публичного доступа используйте `FREEDEEPSEEK_API_KEY`.

---

## Контрибьютинг и тесты

- Тесты: `npm test`
- Для разработки dashboard: `npm --prefix dashboard run dev`
- Fork → PR, сопровождайте изменения тестами и описанием.

---

## Лицензия

MIT — смотрите файл [LICENSE](LICENSE)

---

Если нужно, расширю документацию: переведу `docs/api-documentation.md` на русский, добавлю `CONTRIBUTING.md` и `CHANGELOG.md`, или выполню полный static‑audit кода.


Studio показывает полную карту проекта, активную задачу, события инструментов, файловый diff, аудит запуска и состояние локального API. Выбор модели и прав доступа выполняется из удобных меню; режим `ask` требует отдельного подтверждения задачи, а изменения можно откатить кнопкой Undo.

```powershell
npm run studio:build
deepseek-studio -C C:\path\to\project
```

Откройте `http://127.0.0.1:9660`. Сервер Studio слушает только loopback, а агент остаётся ограничен выбранной через `-C` рабочей папкой. Для разработки интерфейса: `npm --prefix dashboard run dev`.

Сам API и CLI поддерживают Node.js 18+, а локальная пересборка Studio требует Node.js 20.19+ (готовый npm-пакет уже содержит собранный интерфейс).

---

## 🧪 Примеры запросов

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Привет! Ответь одной фразой."}],
    "stream": false
  }'
```

### Reasoning

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Реши коротко: почему небо голубое?"}],
    "stream": false
  }'
```

Для reasoning-моделей API отдаёт цепочку размышления отдельно от финального ответа:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` — приблизительная оценка по извлечённому DeepSeek Web `THINK`-тексту, потому что web stream не отдаёт официальный token usage по reasoning отдельно.

### Web search

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-search",
    "messages": [{"role": "user", "content": "Найди свежий факт про DeepSeek и ответь кратко."}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Напиши короткую шутку."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Ответь ровно OK"}],
    "stream": false
  }'
```

Для Claude Code можно указывать backend напрямую:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Ответь ровно OK",
    "stream": false
  }'
```

### Tool calling

FreeDeepseekAPI принимает:

- OpenAI `tools`;
- Anthropic `tools`;
- Responses API function tools.

Прокси просит DeepSeek вернуть строгий JSON tool call, но также умеет парсить fallback-форматы:

- `TOOL_CALL:`
- fenced JSON
- `<tool_call>...</tool_call>`

---

## 🧠 Модели

`GET /v1/models` возвращает только aliases, которые сейчас проверены и работают через этот proxy.

### Рабочие aliases

| Alias | Web mode | Reasoning | Web search | Комментарий |
| --- | --- | --- | --- | --- |
| `deepseek-chat` | `Быстрый` / `default` | нет | нет | базовый chat |
| `deepseek-v3` | `Быстрый` / `default` | нет | нет | совместимый alias |
| `deepseek-default` | `Быстрый` / `default` | нет | нет | совместимый alias |
| `deepseek-reasoner` | `Быстрый` / `default` | да | нет | `thinking_enabled=true` |
| `deepseek-r1` | `Быстрый` / `default` | да | нет | R1-compatible alias |
| `deepseek-chat-search` | `Быстрый` / `default` | нет | да | web search |
| `deepseek-default-search` | `Быстрый` / `default` | нет | да | web search alias |
| `deepseek-reasoner-search` | `Быстрый` / `default` | да | да | reasoning + search |
| `deepseek-r1-search` | `Быстрый` / `default` | да | да | R1-compatible + search |
| `deepseek-expert` | `Эксперт` / `expert` | нет | нет | Expert mode |
| `deepseek-v4-pro` | `Эксперт` / `expert` | да | нет | Expert + reasoning |

Полный маппинг:

```bash
curl http://localhost:9655/v1/model-capabilities
```

По официальной странице DeepSeek V4 Preview `deepseek-chat` и `deepseek-reasoner` сейчас route'ятся в `deepseek-v4-flash` non-thinking/thinking. В самом `chat.deepseek.com` direct stream точное имя чекпойнта не отдаётся (`model: ""`), поэтому proxy фиксирует одновременно web-режим (`default` / `Быстрый`) и актуальную официальную маршрутизацию (`DeepSeek-V4-Flash`).

Текущий вывод DeepSeek Web remote config показывает такие web-режимы:

- `default` / UI `Быстрый` — работает; поддерживает `thinking_enabled` и `search_enabled`.
- `expert` / UI `Эксперт` — работает через актуальный web-контракт (`x-client-version=2.0.0`) и поддерживает `thinking_enabled`. В `/v1/models` выдаются `deepseek-expert` без reasoning и `deepseek-v4-pro` как Expert + reasoning.
- `vision` / UI `Распознавание` — виден в remote config, но сейчас direct Web API возвращает `backend_err_by_model` (`Vision is temporarily unavailable`). Поэтому `deepseek-vision` скрыт из `/v1/models`.

Search для Expert по remote config недоступен, поэтому `deepseek-expert-search` остаётся unsupported.

---

## 🔌 Endpoints

| Method | Path | Назначение |
| --- | --- | --- |
| `GET` | `/` или `/health` | статус proxy |
| `GET` | `/v1/models` | список рабочих OpenAI-compatible aliases |
| `GET` | `/v1/model-capabilities` | полный маппинг aliases, real model, capabilities |
| `POST` | `/v1/chat/completions` | OpenAI-compatible Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages API shim |
| `POST` | `/v1/responses` | OpenAI Responses API shim |
| `GET` | `/v1/sessions` | активные локальные agent sessions |
| `POST` | `/reset-session?agent=<id>` | сбросить одну session |
| `POST` | `/reset-session?agent=all` | сбросить все sessions |

---

## 🖥 Open WebUI

Base URL для Open WebUI в Docker:

```text
http://host.docker.internal:9655/v1
```

Для локального запуска без Docker:

```text
http://localhost:9655/v1
```

API key можно указать любой: proxy сам ходит в DeepSeek Web через сохранённую browser-сессию.

---

## 🔐 Обновить логин

```bash
npm run auth
npm start
```

Если DeepSeek начал отвечать `401`, `403` или просит новый PoW/session — повторите `npm run auth` и обновите сохранённую browser-сессию.

Локальные файлы авторизации не должны попадать в GitHub:

- `deepseek-auth.json`
- `.chrome-profile-deepseek/`
- `.env`

Они уже добавлены в `.gitignore`.

---

## 🧪 Тесты

Синтаксическая проверка проекта:

```bash
npm test
```

Live smoke-тесты против запущенного локального proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-chat npm run test:live
```

---

## 📌 Статус проекта

FreeDeepseekAPI — экспериментальный web-chat proxy для локального использования и интеграций. Он зависит от текущего контракта DeepSeek Web Chat, поэтому при изменениях на стороне DeepSeek может потребоваться обновление auth/session logic или model mapping.

Если что-то перестало работать:

1. обновите логин через `npm run auth`;
2. проверьте `/v1/model-capabilities`;
3. повторите запрос на свежей сессии;
4. если проблема сохраняется — вероятно, DeepSeek изменил внутренний Web API.

---

<p align="center">
  <strong>ForgetMeAI</strong> · <a href="https://t.me/forgetmeai">Telegram</a>
</p>
#   f r e e d e e p s e e k a p i 
 
 