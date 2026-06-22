import { expect, test } from '@playwright/test';

function fixtureState() {
  return {
    workspace: 'C:\\projects\\example',
    projects: [
      { path: 'C:\\projects\\example', name: 'example', active: true },
      { path: 'C:\\projects\\second', name: 'second', active: false },
    ],
    config: { permissionMode: 'ask', historyEnabled: true },
    project: {
      name: 'example', fileCount: 2, testFileCount: 1, totalBytes: 2048,
      languages: [{ name: 'JavaScript', count: 2 }],
      files: [
        { path: 'README.md', bytes: 20, isTest: false },
        { path: 'src/app.js', bytes: 100, isTest: true },
      ],
    },
    runs: [],
    task: null,
    conversation: { sessionId: 'e2e-session', exchanges: 2, enabled: true },
    memory: { entries: [
      { key: 'api-style', value: 'Keep OpenAI compatibility', type: 'constraint', updatedAt: '2026-06-20T00:00:00.000Z' },
      { key: 'next-release', value: 'Add migration notes', type: 'todo', updatedAt: '2026-06-20T00:00:00.000Z' },
    ] },
    api: {
      online: true, baseUrl: 'http://127.0.0.1:9655', health: { status: 'ok' },
      models: [
        { id: 'deepseek-chat' },
        { id: 'deepseek-reasoner' },
        { id: 'deepseek-chat-search' },
      ],
    },
  };
}

async function mockStudioApi(page) {
  const state = fixtureState();
  const git = {
    available: true, repository: true, root: state.workspace, branch: 'main', upstream: 'origin/main',
    ahead: 1, behind: 0, dirty: true, truncated: false,
    files: [{ path: 'src/app.js', index: ' ', worktree: 'M', staged: false, untracked: false }],
    diff: '# Working tree\n--- a/src/app.js\n+++ b/src/app.js\n+console.log("changed");',
  };
  const calls = { commits: [], pushes: 0, projects: [] };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/state') return route.fulfill({ json: state });
    if (url.pathname === '/api/git' && request.method() === 'GET') return route.fulfill({ json: git });
    if (url.pathname === '/api/file') return route.fulfill({ json: { path: url.searchParams.get('path'), content: '# example\n' } });
    if (url.pathname === '/api/tasks' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.task = { id: 'task-e2e', ...body, status: 'running', lines: [] };
      return route.fulfill({ status: 202, json: state.task });
    }
    if (url.pathname === '/api/tasks/cancel') {
      state.task = { ...state.task, status: 'cancelled', finishedAt: new Date().toISOString() };
      return route.fulfill({ status: 202, json: state.task });
    }
    if (url.pathname === '/api/session/reset') {
      state.conversation.exchanges = 0;
      return route.fulfill({ json: { status: 'context_reset' } });
    }
    if (url.pathname === '/api/memory/forget') {
      const body = request.postDataJSON();
      state.memory.entries = state.memory.entries.filter(entry => entry.key !== body.key);
      return route.fulfill({ json: { key: body.key, deleted: true } });
    }
    if (url.pathname === '/api/memory/clear') {
      state.memory.entries = [];
      return route.fulfill({ json: { status: 'memory_cleared' } });
    }
    if (url.pathname === '/api/projects' && request.method() === 'POST') {
      const body = request.postDataJSON(); calls.projects.push(body);
      state.workspace = body.path;
      state.projects = state.projects.map(project => ({ ...project, active: project.path === body.path }));
      state.project = { ...state.project, name: 'second', files: [{ path: 'SECOND.md', bytes: 12, isTest: false }] };
      return route.fulfill({ json: { workspace: state.workspace, projects: state.projects } });
    }
    if (url.pathname === '/api/git/commit') {
      const body = request.postDataJSON(); calls.commits.push(body); git.dirty = false; git.files = []; git.diff = '';
      return route.fulfill({ json: { hash: 'abc1234', message: body.message } });
    }
    if (url.pathname === '/api/git/push') {
      const body = request.postDataJSON(); if (body.confirmed) calls.pushes++;
      return route.fulfill({ json: { branch: 'main', upstream: 'origin/main' } });
    }
    if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"connected"}\n\n' });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return { state, git, calls };
}

test('model, permission and project controls update visible state', async ({ page }, testInfo) => {
  await mockStudioApi(page);
  await page.goto('/');
  await expect(page).toHaveTitle('DeepSeek Agent Studio');
  await expect(page.getByText('Задача ещё не запущена')).toBeVisible();
  await expect(page.getByText('get_project_map')).toHaveCount(0);
  if (testInfo.project.name === 'mobile') await expect(page.getByRole('button', { name: /Рабочая папка/ })).toBeVisible();
  else await expect(page.getByText('DeepSeek Agent Studio')).toBeVisible();

  await page.getByRole('button', { name: 'Модель deepseek-chat' }).click();
  await page.getByRole('menuitemradio', { name: /deepseek-reasoner/ }).click();
  await expect(page.getByRole('button', { name: 'Модель deepseek-reasoner' })).toBeVisible();

  await page.getByRole('button', { name: /Режим Запрашивать разрешение/ }).click();
  await page.getByRole('menuitemradio', { name: /Только чтение/ }).click();
  await expect(page.getByRole('button', { name: /Режим Только чтение/ })).toBeVisible();

  await page.getByPlaceholder('Найти файл').fill('src/');
  await expect(page.getByRole('button', { name: 'app.js' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'README.md' })).toHaveCount(0);
});

test('task can be started, cancelled and conversation context reset', async ({ page }, testInfo) => {
  const { state } = await mockStudioApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Режим Запрашивать разрешение/ }).click();
  await page.getByRole('menuitemradio', { name: /Только чтение/ }).click();
  await page.getByPlaceholder('Опишите задачу для агента…').fill('Проверь проект');
  await page.getByRole('button', { name: /Запустить/ }).click();
  await expect(page.getByRole('button', { name: 'Остановить' })).toBeVisible();
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect(page.getByRole('button', { name: /Запустить/ })).toBeVisible();
  await expect(page.getByText('Отменено')).toBeVisible();
  expect(state.task.status).toBe('cancelled');

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Новый диалог' }).click();
  await expect.poll(() => state.conversation.exchanges).toBe(0);
  if (testInfo.project.name !== 'mobile') await expect(page.getByText('Контекст проекта: 0 диалогов')).toBeVisible();
});

test('project switching and confirmed Git actions are visible and functional', async ({ page }) => {
  const { calls } = await mockStudioApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: /Рабочая папка/ }).click();
  await page.getByRole('menuitemradio', { name: /second/ }).click();
  await expect(page.getByRole('button', { name: /Рабочая папка C:\\projects\\second/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SECOND.md' })).toBeVisible();
  expect(calls.projects).toEqual([{ path: 'C:\\projects\\second' }]);

  await page.getByPlaceholder('Кратко опишите изменения').fill('E2E commit');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Commit' }).click();
  await expect(page.getByText('чисто')).toBeVisible();
  expect(calls.commits).toEqual([{ message: 'E2E commit', confirmed: true }]);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Push' }).click();
  await expect.poll(() => calls.pushes).toBe(1);
});

test('durable project memory can be reviewed and cleared', async ({ page }) => {
  const { state } = await mockStudioApi(page);
  await page.goto('/');
  await expect(page.getByText('api-style')).toBeVisible();
  await expect(page.getByText('Keep OpenAI compatibility')).toBeVisible();

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Удалить api-style' }).click();
  await expect(page.getByText('api-style')).toHaveCount(0);
  expect(state.memory.entries).toHaveLength(1);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Очистить' }).click();
  await expect(page.getByText('Память пока пуста')).toBeVisible();
  expect(state.memory.entries).toHaveLength(0);
});
