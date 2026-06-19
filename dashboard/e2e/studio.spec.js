import { expect, test } from '@playwright/test';

function fixtureState() {
  return {
    workspace: 'C:\\projects\\example',
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
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/state') return route.fulfill({ json: state });
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
    if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"connected"}\n\n' });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return state;
}

test('model, permission and project controls update visible state', async ({ page }) => {
  await mockStudioApi(page);
  await page.goto('/');
  await expect(page).toHaveTitle('DeepSeek Agent Studio');
  await expect(page.getByText('DeepSeek Agent Studio')).toBeVisible();

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

test('task can be started, cancelled and conversation context reset', async ({ page }) => {
  const state = await mockStudioApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Режим Запрашивать разрешение/ }).click();
  await page.getByRole('menuitemradio', { name: /Только чтение/ }).click();
  await page.getByPlaceholder('Опишите задачу для агента…').fill('Проверь проект');
  await page.getByRole('button', { name: /Запустить/ }).click();
  await expect(page.getByRole('button', { name: 'Остановить' })).toBeVisible();
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect(page.getByRole('button', { name: /Запустить/ })).toBeVisible();
  expect(state.task.status).toBe('cancelled');

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Новый диалог' }).click();
  await expect(page.getByText('Контекст проекта: 0 диалогов')).toBeVisible();
});
