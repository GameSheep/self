import { defineConfig, devices } from '@playwright/test';

/**
 * Self-Hub regression suite.
 *
 * `npm run test:e2e` starts the dev server automatically (vite picks the first
 * free port at or after PORT/5173) and drives the real UI in Chromium.
 */
const PORT = Number(process.env.E2E_PORT || 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
/** Production-bundle smoke test; see the `webServer` comment below. */
const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT || 4173);
export const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;

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
  /**
   * Two servers, on purpose.
   *
   * Everything else runs against the **dev server**, which does not tree-shake or split
   * chunks — so no test could see a production-only bundling problem (a module dropped by
   * `sideEffects`, a chunk that stopped being emitted, a lazy import that no longer loads).
   * `production-build.spec.ts` drives the **built** bundle through `vite preview`; it is the
   * only place where the shipped artifact is exercised.
   */
  webServer: [
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 120_000
    },
    {
      command: `npm run build && npm run preview -- --port ${PREVIEW_PORT} --strictPort`,
      url: PREVIEW_URL,
      reuseExistingServer: false,
      timeout: 180_000
    }
  ]
});
