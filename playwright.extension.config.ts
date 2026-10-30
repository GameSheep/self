import { defineConfig, devices } from '@playwright/test';

/**
 * 只跑「真实扩展上下文」的用例。
 *
 * 这些用例自己 `launchPersistentContext` 加载 `extension/`，不需要 dev server，
 * 也不需要先 build 生产包。用主配置跑会白等一次 `npm run build`（约两分钟），
 * 迭代新标签页时完全没必要。
 *
 *   npx playwright test --config=playwright.extension.config.ts
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['newtab-dashboard.spec.ts', 'extension-protocol.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 }
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
