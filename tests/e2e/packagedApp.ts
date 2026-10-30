import { expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Guard against testing a stale build.
 *
 * The workbench cases under `tests/e2e` load `chrome-extension://<id>/app/index.html`,
 * which is the **built bundle** in `extension/app/assets` — not `src/`. Edit `src/`,
 * forget `npm run package:extension`, and the suite happily exercises the previous
 * build: a bug you just fixed stays red, a bug you did not fix stays green. Both
 * directions cost more time than this check does.
 *
 * The 60-second slack keeps a fresh `git clone` (where every file gets the checkout
 * mtime, within milliseconds of each other) from failing spuriously, while still
 * catching a bundle that is minutes or hours behind.
 */
export function assertPackagedAppFresh(extPath: string): void {
  const newest = (dir: string): number => {
    let latest = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      latest = Math.max(latest, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs);
    }
    return latest;
  };
  const src = newest(path.join(process.cwd(), 'src'));
  const built = newest(path.join(extPath, 'app', 'assets'));
  expect(
    built,
    '工作台打包产物比 src/ 旧：先跑 npm run package:extension，否则测的是旧代码'
  ).toBeGreaterThan(src - 60_000);
}
