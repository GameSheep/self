import { test, expect } from '@playwright/test';

/**
 * 「从扩展同步」的**网页环境**诊断路径。
 *
 * 网页版工作台（localhost 等）没有 chrome API，读不到扩展存储——这不是 bug，
 * 但绝不能是"点了没反应"。按钮必须明确说出原因，把用户引回扩展内的工作台。
 */
test('网页环境下点「从扩展同步」明确提示读不到扩展', async ({ page }) => {
  await page.goto('/#/library?type=webpage');
  await expect(page.getByTestId('annotations-pane')).toBeVisible({ timeout: 20_000 });

  // Fresh profile shows the first-run wizard; dismiss it if present.
  const skip = page.getByRole('button', { name: /跳过|开始使用/ });
  if (await skip.count()) await skip.first().click();

  await page.getByTestId('annotations-sync-extension').click();
  const result = page.getByTestId('annotations-sync-result');
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result).toContainText('不是扩展内的工作台');
});
