/**
 * Extension options page (P2-04).
 *
 * Dev doc §9.1: "options 页只负责跳转 `app/index.html#/settings/browser` 等统一入口。
 * 使用偏好通过同一仓库查询；不再在 options.js 中保留第二套 S3/WebDAV 密钥表单."
 *
 * So this page no longer holds any configuration form. The old file had its own
 * S3 and WebDAV key inputs plus an auto-sync toggle — a second source of truth for
 * the same credentials, which is precisely how the two sync systems drifted apart.
 *
 * What it does now:
 *  - redirects to the packed app's settings route, preserving the hash so a link
 *    to `options.html#/settings/connections` still lands on the right pane;
 *  - reports the legacy state honestly (`legacySync` is still on disk, but it is
 *    not configured here any more);
 *  - keeps a visible button, because an automatic redirect that is blocked leaves
 *    the user staring at nothing.
 */
'use strict';

const SETTINGS_ROUTE = 'app/index.html#/settings/connections';

function targetUrl(hash) {
  // A caller may pass its own route through the hash: options.html#/settings/x
  if (hash && hash.startsWith('#/')) {
    return `app/index.html${hash}`;
  }
  return SETTINGS_ROUTE;
}

document.addEventListener('DOMContentLoaded', () => {
  const openButton = document.getElementById('open-settings');
  const target = targetUrl(window.location.hash);

  if (openButton) {
    openButton.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(target) });
      window.close();
    });
  }

  // The legacy SyncManager config may still exist from an older install. Say so
  // rather than silently ignoring it: the user needs to know why a sync that used
  // to run is no longer configured here.
  chrome.storage.local.get(['selfhub_sync_config'], (result) => {
    const config = result && result.selfhub_sync_config;
    const note = document.getElementById('legacy-note');
    if (!note) return;
    if (config && config.provider && config.provider !== 'none') {
      note.hidden = false;
      note.textContent =
        '这台浏览器里还留着旧版独立同步的配置（' +
        config.provider +
        '）。它不再由本页面维护，也不会被自动启用；如需继续使用，请在统一设置里重新配置连接与用途，确认后再关闭旧同步。';
    }
  });

  // Redirect once the DOM is ready. The button above stays as the fallback.
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL(target) }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* leave the button */
  }
});
