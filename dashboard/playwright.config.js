import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 20_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  use: {
    baseURL: 'http://127.0.0.1:9662',
    browserName: 'chromium',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node ../studio-server.js -C .. --port 9662',
    cwd: '.',
    url: 'http://127.0.0.1:9662/api/state',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
