import { defineConfig, devices } from '@playwright/test';

/**
 * Self-Hub regression suite.
 *
 * `npm run test:e2e` starts the dev server automatically (vite picks the first
 * free port at or after PORT/5173) and drives the real UI in Chromium.
 */
const PORT = Number(process.env.E2E_PORT || 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/.report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 }
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000
  }
});
